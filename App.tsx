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
import type { WebViewNavigation } from "react-native-webview";

const SITE_URL = "https://taxiimpulse.ru";
const BACKGROUND_NOTIFICATION_TASK = "BACKGROUND_NOTIFICATION_TASK";

TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, ({ data, error }: any) => {
  if (error) return;
  if (data?.notification) {
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
  }
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
  } catch (e) {}
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

    function registerFcmWithServer() {
      var fcmToken = window.__TAXI_FCM_TOKEN__;
      if (!fcmToken) return;
      var authToken = localStorage.getItem('taxi_token');
      if (!authToken) return;
      fetch('https://taxiimpulse.ru/api/push/fcm-token', {
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
      fetch('https://taxiimpulse.ru/api/push/poll', {
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
            JSON.stringify({ type: 'POLL_STATUS', status: 'network_error', error: String(err) })
          );
        } catch(e) {}
      });
    }

    function startPolling() {
      pollNotifications();
      setInterval(pollNotifications, 20000);
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

    window.addEventListener('taxi-user-login', function() {
      setTimeout(registerFcmWithServer, 1000);
      setTimeout(pollNotifications, 500);
    });
  })();
  true;
`;
}

// Внутренний банер уведомления (виден даже без разрешений Android)
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
  const appStateRef = useRef(AppState.currentState);
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLoadedOnce = useRef(false);
  const [fcmToken, setFcmToken] = useState<string | null>(null);
  const injectedJS = buildInjectedJS(fcmToken);

  // Очередь in-app баннеров
  const [banners, setBanners] = useState<Array<{ id: number; title: string; body: string }>>([]);
  const bannerIdRef = useRef(0);
  const [pollStatus, setPollStatus] = useState<{ status: string; count?: number; error?: string } | null>(null);

  const showBanner = useCallback((title: string, body: string) => {
    const id = ++bannerIdRef.current;
    setBanners(prev => [...prev.slice(-2), { id, title, body }]);
  }, []);

  useEffect(() => {
    const requestPerms = async () => {
      try {
        const { status } = await Notifications.requestPermissionsAsync();
        if (status !== "granted") {
          console.warn("[TAXI] Notification permission denied");
        }
      } catch {}
    };
    requestPerms();

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

    const registerPushToken = async () => {
      try {
        const tokenData = await Notifications.getDevicePushTokenAsync();
        if (tokenData?.data) setFcmToken(tokenData.data);
      } catch {}
    };
    registerPushToken();

    Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK).catch(() => {});

    const sub = AppState.addEventListener("change", (s) => { appStateRef.current = s; });
    return () => sub.remove();
  }, []);

  const fcmRegisteredRef = useRef(false);
  useEffect(() => {
    if (fcmToken && !fcmRegisteredRef.current && hasLoadedOnce.current) {
      fcmRegisteredRef.current = true;
      webviewRef.current?.injectJavaScript(`
        window.__TAXI_FCM_TOKEN__ = ${JSON.stringify(fcmToken)};
        try {
          window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
            JSON.stringify({ type: 'FCM_TOKEN_READY', token: ${JSON.stringify(fcmToken)} })
          );
        } catch(e) {}
        true;
      `);
    }
  }, [fcmToken]);

  const handleMessage = useCallback(async (event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);

      if (msg.type === "NOTIFICATION") {
        const title = msg.title || "Taxi Impulse";
        const body = msg.body || "";

        // 1. Звук
        playNotificationSound();

        // 2. Системное уведомление Android
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

        // 3. In-app банер (всегда видно, даже если разрешения нет)
        showBanner(title, body);
      }

      if (msg.type === "POLL_STATUS") {
        setPollStatus({ status: msg.status, count: msg.count, error: msg.error });
        return;
      }

      if (msg.type === "USER_LOGGED_IN" && fcmToken) {
        webviewRef.current?.injectJavaScript(`
          window.__TAXI_FCM_TOKEN__ = ${JSON.stringify(fcmToken)};
          try {
            window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
              JSON.stringify({ type: 'FCM_TOKEN_READY', token: ${JSON.stringify(fcmToken)} })
            );
          } catch(e) {}
          true;
        `);
      }
    } catch {}
  }, [fcmToken, showBanner]);

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
        injectedJavaScript={injectedJS}
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

      {/* Статус polling (диагностика) */}
      {pollStatus && (
        <View style={[styles.pollIndicator, {
          backgroundColor: pollStatus.status === 'ok' ? 'rgba(34,197,94,0.15)' :
                           pollStatus.status === 'no_token' ? 'rgba(251,191,36,0.15)' :
                           'rgba(239,68,68,0.15)',
        }]}>
          <Text style={[styles.pollIndicatorText, {
            color: pollStatus.status === 'ok' ? '#86efac' :
                   pollStatus.status === 'no_token' ? '#fde68a' : '#fca5a5',
          }]}>
            {pollStatus.status === 'ok' ? `✓ Polling активен` :
             pollStatus.status === 'no_auth' ? '✗ Нет авторизации (войдите в аккаунт)' :
             pollStatus.status === 'no_token' ? '⚠ Войдите в аккаунт для уведомлений' :
             `✗ Ошибка: ${pollStatus.status}`}
          </Text>
        </View>
      )}

      {/* In-app баннеры уведомлений */}
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
