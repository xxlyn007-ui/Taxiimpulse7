import { useRef, useState, useCallback, useEffect } from "react";
import {
  StyleSheet,
  View,
  ActivityIndicator,
  Text,
  TouchableOpacity,
  Platform,
  BackHandler,
  StatusBar,
  AppState,
  Animated,
} from "react-native";
import { WebView } from "react-native-webview";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { Audio } from "expo-av";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import * as BackgroundFetch from "expo-background-fetch";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { WebViewNavigation } from "react-native-webview";

const SITE_URL = "https://taxiimpulse.ru";
const API_BASE = "https://taxiimpulse.ru/api";
const TOKEN_KEY = "taxi_auth_token";
const BG_FETCH_TASK = "TAXI_BG_POLL";
const BG_NOTIFICATION_TASK = "BACKGROUND_NOTIFICATION_TASK";

// ── Фоновый опрос (работает даже когда приложение закрыто) ─────────────────
TaskManager.defineTask(BG_FETCH_TASK, async () => {
  try {
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    if (!token) return BackgroundFetch.BackgroundFetchResult.NoData;

    const resp = await fetch(`${API_BASE}/push/poll`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return BackgroundFetch.BackgroundFetchResult.Failed;

    const data = await resp.json();
    if (!data?.notifications?.length) return BackgroundFetch.BackgroundFetchResult.NoData;

    for (const n of data.notifications) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: n.title || "Taxi Impulse",
          body: n.body || "",
          sound: "notification.mp3",
          priority: Notifications.AndroidNotificationPriority.HIGH,
          data: { fromBackground: true },
        },
        trigger: null,
      });
    }
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

// ── FCM фоновый обработчик ──────────────────────────────────────────────────
TaskManager.defineTask(BG_NOTIFICATION_TASK, ({ data, error }: any) => {
  if (error || !data?.notification) return;
  const { title, body } = data.notification;
  Notifications.scheduleNotificationAsync({
    content: {
      title: title || "Taxi Impulse",
      body: body || "",
      sound: "notification.mp3",
      priority: Notifications.AndroidNotificationPriority.HIGH,
    },
    trigger: null,
  }).catch(() => {});
});

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function registerBackgroundFetch() {
  try {
    const status = await BackgroundFetch.getStatusAsync();
    if (
      status === BackgroundFetch.BackgroundFetchStatus.Restricted ||
      status === BackgroundFetch.BackgroundFetchStatus.Denied
    ) return;

    const isRegistered = await TaskManager.isTaskRegisteredAsync(BG_FETCH_TASK);
    if (!isRegistered) {
      await BackgroundFetch.registerTaskAsync(BG_FETCH_TASK, {
        minimumInterval: 60 * 15,
        stopOnTerminate: false,
        startOnBoot: true,
      });
    }
  } catch {}
}

async function playNotificationSound() {
  try {
    await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
    const { sound } = await Audio.Sound.createAsync(
      require("./assets/notification.mp3"),
      { shouldPlay: true, volume: 1.0 }
    );
    sound.setOnPlaybackStatusUpdate((s) => {
      if (s.isLoaded && s.didJustFinish) sound.unloadAsync().catch(() => {});
    });
  } catch {}
}

function buildInjectedJS(fcmToken: string | null) {
  return `
  (function() {
    window.__TAXI_NATIVE_APP__ = true;
    window.__TAXI_APP_PLATFORM__ = '${Platform.OS}';
    window.__TAXI_FCM_TOKEN__ = ${fcmToken ? JSON.stringify(fcmToken) : "null"};
    document.documentElement.setAttribute('data-native-app', 'true');

    function NativeNotification(title, options) {
      try {
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: 'NOTIFICATION', title: title, body: (options && options.body) || '' })
        );
      } catch(e) {}
    }
    NativeNotification.requestPermission = function() { return Promise.resolve('granted'); };
    NativeNotification.permission = 'granted';
    try { window.Notification = NativeNotification; } catch(e) {}

    var lastSentToken = null;
    function syncToken() {
      var t = localStorage.getItem('taxi_token');
      if (t && t !== lastSentToken) {
        lastSentToken = t;
        try {
          window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
            JSON.stringify({ type: 'SAVE_TOKEN', token: t })
          );
        } catch(e) {}
      }
    }

    function registerFcmWithServer() {
      var fcmToken = window.__TAXI_FCM_TOKEN__;
      if (!fcmToken) return;
      var authToken = localStorage.getItem('taxi_token');
      if (!authToken) return;
      fetch('${API_BASE}/push/fcm-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
        body: JSON.stringify({ fcmToken: fcmToken })
      }).catch(function() {});
    }

    function pollNotifications() {
      var authToken = localStorage.getItem('taxi_token');
      if (!authToken) {
        try {
          window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
            JSON.stringify({ type: 'POLL_STATUS', status: 'no_token' })
          );
        } catch(e) {}
        return;
      }
      fetch('${API_BASE}/push/poll', {
        headers: { 'Authorization': 'Bearer ' + authToken }
      }).then(function(r) {
        return r.ok ? r.json() : { error: 'http_' + r.status };
      }).then(function(data) {
        try {
          window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
            JSON.stringify({ type: 'POLL_STATUS', status: data.debug || 'ok', count: (data.notifications || []).length })
          );
        } catch(e) {}
        if (!data || !data.notifications || !data.notifications.length) return;
        data.notifications.forEach(function(n) {
          try {
            window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
              JSON.stringify({ type: 'NOTIFICATION', title: n.title, body: n.body })
            );
          } catch(e) {}
        });
      }).catch(function(err) {
        try {
          window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
            JSON.stringify({ type: 'POLL_STATUS', status: 'network_error' })
          );
        } catch(e) {}
      });
    }

    function startPolling() {
      syncToken();
      pollNotifications();
      setInterval(function() {
        syncToken();
        pollNotifications();
      }, 20000);
    }

    function tryInit() {
      setTimeout(registerFcmWithServer, 2000);
      setTimeout(registerFcmWithServer, 7000);
      setTimeout(startPolling, 3000);
    }

    if (document.readyState === 'complete') {
      tryInit();
    } else {
      window.addEventListener('load', tryInit);
    }

    window.addEventListener('storage', function(e) {
      if (e.key === 'taxi_token') { syncToken(); setTimeout(pollNotifications, 500); }
    });
  })();
  true;
`;
}

function InAppBanner({ title, body, onDismiss }: { title: string; body: string; onDismiss: () => void }) {
  const translateY = useRef(new Animated.Value(-120)).current;

  useEffect(() => {
    Animated.spring(translateY, { toValue: 0, useNativeDriver: true, speed: 20 }).start();
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, []);

  const hide = () => {
    Animated.timing(translateY, { toValue: -120, duration: 250, useNativeDriver: true }).start(onDismiss);
  };

  return (
    <Animated.View style={[styles.banner, { transform: [{ translateY }] }]}>
      <View style={styles.bannerContent}>
        <Text style={styles.bannerTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.bannerBody} numberOfLines={2}>{body}</Text>
      </View>
      <TouchableOpacity onPress={hide} style={styles.bannerClose}>
        <Text style={styles.bannerCloseText}>✕</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

function WebViewScreen() {
  const insets = useSafeAreaInsets();
  const webviewRef = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLoadedOnce = useRef(false);
  const [fcmToken, setFcmToken] = useState<string | null>(null);
  // Stable ref — buildInjectedJS runs once to avoid WebView reload on token change
  const injectedJSRef = useRef(buildInjectedJS(null));

  const [banners, setBanners] = useState<Array<{ id: number; title: string; body: string }>>([]);
  const bannerIdRef = useRef(0);
  const [pollStatus, setPollStatus] = useState<{ status: string } | null>(null);

  const showBanner = useCallback((title: string, body: string) => {
    const id = ++bannerIdRef.current;
    setBanners(prev => [...prev.slice(-2), { id, title, body }]);
  }, []);

  useEffect(() => {
    const setup = async () => {
      try {
        const { status } = await Notifications.requestPermissionsAsync();
        if (status !== "granted") console.warn("[TAXI] Notifications blocked");
      } catch {}

      if (Platform.OS === "android") {
        Notifications.setNotificationChannelAsync("taxi-impulse", {
          name: "Taxi Impulse",
          importance: Notifications.AndroidImportance.HIGH,
          sound: "notification.mp3",
          vibrationPattern: [0, 250, 250, 250],
          enableVibrate: true,
          lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
          bypassDnd: false,
        }).catch(() => {});
      }

      try {
        const tokenData = await Notifications.getDevicePushTokenAsync();
        if (tokenData?.data) setFcmToken(tokenData.data);
      } catch {}

      Notifications.registerTaskAsync(BG_NOTIFICATION_TASK).catch(() => {});
      await registerBackgroundFetch();
    };

    setup();
  }, []);

  // Inject FCM token into WebView without reloading the page
  useEffect(() => {
    if (fcmToken) {
      const script = `try { window.__TAXI_FCM_TOKEN__ = ${JSON.stringify(fcmToken)}; } catch(e) {} true;`;
      webviewRef.current?.injectJavaScript(script);
    }
  }, [fcmToken]);

  useEffect(() => {
    const appSub = AppState.addEventListener("change", (s) => {
      if (s === "active") {
        webviewRef.current?.injectJavaScript(`
          try {
            var t = localStorage.getItem('taxi_token');
            if (t) window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SAVE_TOKEN', token: t }));
          } catch(e) {}
          true;
        `);
      }
    });

    return () => appSub.remove();
  }, []);

  const handleMessage = useCallback(async (event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);

      if (msg.type === "SAVE_TOKEN" && msg.token) {
        await AsyncStorage.setItem(TOKEN_KEY, msg.token);
        return;
      }

      if (msg.type === "POLL_STATUS") {
        setPollStatus({ status: msg.status });
        return;
      }

      if (msg.type === "NOTIFICATION") {
        const title = msg.title || "Taxi Impulse";
        const body = msg.body || "";

        playNotificationSound();

        try {
          await Notifications.scheduleNotificationAsync({
            content: {
              title,
              body,
              sound: "notification.mp3",
              priority: Notifications.AndroidNotificationPriority.HIGH,
            },
            trigger: null,
          });
        } catch {}

        showBanner(title, body);
      }
    } catch {}
  }, [showBanner]);

  const handleBack = useCallback(() => {
    if (canGoBack) { webviewRef.current?.goBack(); return true; }
    return false;
  }, [canGoBack]);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", handleBack);
    return () => sub.remove();
  }, [handleBack]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor="#19063e" />

      {loading && !error && (
        <View style={styles.loadingOverlay}>
          <Text style={styles.loadingTitle}>TAXI IMPULSE</Text>
          <ActivityIndicator size="large" color="#7c3aed" style={{ marginTop: 24 }} />
          <Text style={styles.loadingHint}>Загрузка...</Text>
        </View>
      )}

      {error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>Нет соединения</Text>
          <Text style={styles.errorText}>Проверьте интернет и повторите попытку</Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => {
              hasLoadedOnce.current = false;
              setError(false);
              setLoading(true);
              webviewRef.current?.reload();
            }}
          >
            <Text style={styles.retryText}>Повторить</Text>
          </TouchableOpacity>
        </View>
      )}

      <WebView
        ref={webviewRef}
        source={{ uri: SITE_URL }}
        style={[styles.webview, error && styles.hidden]}
        injectedJavaScript={injectedJSRef.current}
        javaScriptEnabled
        domStorageEnabled
        allowsBackForwardNavigationGestures
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        onNavigationStateChange={(nav: WebViewNavigation) => setCanGoBack(nav.canGoBack)}
        onLoadStart={() => {
          if (!hasLoadedOnce.current) {
            setLoading(true);
            setError(false);
            if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
            loadingTimerRef.current = setTimeout(() => {
              setLoading(false);
              setError(true);
            }, 25000);
          }
        }}
        onLoadEnd={() => {
          if (!hasLoadedOnce.current) {
            hasLoadedOnce.current = true;
            if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
            setLoading(false);
          }
        }}
        onError={() => {
          if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
          setLoading(false);
          setError(true);
        }}
        onHttpError={(e) => {
          if (e.nativeEvent.statusCode >= 500) {
            if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
            setError(true);
            setLoading(false);
          }
        }}
        onMessage={handleMessage}
        userAgent="Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        cacheEnabled
        mixedContentMode="always"
        originWhitelist={["*"]}
        setSupportMultipleWindows={false}
        onContentProcessDidTerminate={() => webviewRef.current?.reload()}
      />

      {pollStatus && (
        <View style={[styles.pollIndicator, {
          backgroundColor: pollStatus.status === "ok"
            ? "rgba(34,197,94,0.15)"
            : pollStatus.status === "no_token"
            ? "rgba(251,191,36,0.15)"
            : "rgba(239,68,68,0.15)",
        }]}>
          <Text style={[styles.pollIndicatorText, {
            color: pollStatus.status === "ok" ? "#86efac"
              : pollStatus.status === "no_token" ? "#fde68a" : "#fca5a5",
          }]}>
            {pollStatus.status === "ok" ? "✓ Уведомления активны (онлайн)"
              : pollStatus.status === "no_auth" ? "✗ Войдите в аккаунт"
              : pollStatus.status === "no_token" ? "⚠ Войдите для получения уведомлений"
              : "✗ Ошибка соединения"}
          </Text>
        </View>
      )}

      {banners.map((b) => (
        <InAppBanner
          key={b.id}
          title={b.title}
          body={b.body}
          onDismiss={() => setBanners(prev => prev.filter(x => x.id !== b.id))}
        />
      ))}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <WebViewScreen />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#19063e" },
  webview: { flex: 1 },
  hidden: { opacity: 0, position: "absolute", width: 0, height: 0 },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#19063e",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  loadingTitle: { color: "#fff", fontSize: 28, fontWeight: "bold", letterSpacing: 4 },
  loadingHint: { color: "rgba(255,255,255,0.5)", fontSize: 14, marginTop: 16 },
  errorContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#19063e",
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    zIndex: 10,
  },
  errorTitle: { color: "#fff", fontSize: 22, fontWeight: "bold", marginBottom: 12 },
  errorText: { color: "rgba(255,255,255,0.6)", fontSize: 15, textAlign: "center", marginBottom: 32 },
  retryButton: { backgroundColor: "#7c3aed", paddingHorizontal: 40, paddingVertical: 14, borderRadius: 12 },
  retryText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  banner: {
    position: "absolute",
    top: 0,
    left: 12,
    right: 12,
    backgroundColor: "#2d1b69",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#7c3aed",
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    zIndex: 100,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 12,
  },
  bannerContent: { flex: 1 },
  bannerTitle: { color: "#fff", fontSize: 15, fontWeight: "700", marginBottom: 3 },
  bannerBody: { color: "rgba(255,255,255,0.8)", fontSize: 13 },
  bannerClose: { paddingLeft: 12, paddingVertical: 4 },
  bannerCloseText: { color: "rgba(255,255,255,0.5)", fontSize: 18 },
  pollIndicator: {
    position: "absolute",
    bottom: 4,
    left: 8,
    right: 8,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    zIndex: 50,
  },
  pollIndicatorText: { fontSize: 11, textAlign: "center" },
});
