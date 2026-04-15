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
} from "react-native";
import { WebView } from "react-native-webview";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { Audio } from "expo-av";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import type { WebViewNavigation } from "react-native-webview";

const SITE_URL = "https://taxiimpulse.ru";
const BACKGROUND_NOTIFICATION_TASK = "BACKGROUND_NOTIFICATION_TASK";

// Handle notifications when app is in background/killed
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

    // Override Notification API to relay to native
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

    // Register FCM token directly with server using localStorage auth
    function registerFcmWithServer() {
      var fcmToken = window.__TAXI_FCM_TOKEN__;
      if (!fcmToken) return;
      try {
        var authToken = localStorage.getItem('taxi_token');
        if (!authToken) return;
        fetch('https://taxiimpulse.ru/api/push/fcm-token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + authToken
          },
          body: JSON.stringify({ fcmToken: fcmToken })
        }).catch(function() {});
      } catch(e) {}
    }

    // Try registering after page load and on every localStorage auth change
    function tryRegister() {
      setTimeout(registerFcmWithServer, 3000);
      setTimeout(registerFcmWithServer, 8000);
    }

    if (document.readyState === 'complete') {
      tryRegister();
    } else {
      window.addEventListener('load', tryRegister);
    }

    // Also listen for auth events triggered by the website
    window.addEventListener('taxi-user-login', function() {
      setTimeout(registerFcmWithServer, 1000);
    });
  })();
  true;
`;
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

  useEffect(() => {
    // Request notification permissions
    Notifications.requestPermissionsAsync().catch(() => {});

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

    // Get device push token (FCM on Android)
    const registerPushToken = async () => {
      try {
        const tokenData = await Notifications.getDevicePushTokenAsync();
        if (tokenData?.data) {
          setFcmToken(tokenData.data);
        }
      } catch (e) {
        // FCM not available (no google-services.json) — use in-app notifications only
      }
    };
    registerPushToken();

    // Register background notification task
    Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK).catch(() => {});

    const sub = AppState.addEventListener("change", (s) => { appStateRef.current = s; });
    return () => sub.remove();
  }, []);

  // When fcmToken is obtained, reload injected JS by reloading WebView once
  const fcmRegisteredRef = useRef(false);
  useEffect(() => {
    if (fcmToken && !fcmRegisteredRef.current && hasLoadedOnce.current) {
      fcmRegisteredRef.current = true;
      // Inject FCM token into already-loaded WebView via evalJS
      webviewRef.current?.injectJavaScript(`
        window.__TAXI_FCM_TOKEN__ = ${JSON.stringify(fcmToken)};
        (function() {
          try {
            window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
              JSON.stringify({ type: 'FCM_TOKEN_READY', token: ${JSON.stringify(fcmToken)} })
            );
          } catch(e) {}
        })();
        true;
      `);
    }
  }, [fcmToken]);

  const handleMessage = useCallback(async (event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);

      if (msg.type === "NOTIFICATION") {
        await playNotificationSound();
        await Notifications.scheduleNotificationAsync({
          content: {
            title: msg.title || "Taxi Impulse",
            body: msg.body || "",
            sound: "notification.mp3",
            priority: Notifications.AndroidNotificationPriority.HIGH,
          },
          trigger: null,
        });
      }

      // Website sends us the user's info so we can associate FCM token
      if (msg.type === "USER_LOGGED_IN" && fcmToken) {
        // Re-inject token so website registers it with the server
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
  }, [fcmToken]);

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
  loadingTitle: {
    color: "#fff",
    fontSize: 28,
    fontWeight: "bold",
    letterSpacing: 4,
  },
  loadingHint: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 14,
    marginTop: 16,
  },
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
  retryButton: {
    backgroundColor: "#7c3aed",
    paddingHorizontal: 40,
    paddingVertical: 14,
    borderRadius: 12,
  },
  retryText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
