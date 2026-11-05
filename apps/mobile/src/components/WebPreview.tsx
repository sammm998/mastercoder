import { useState, type ComponentType } from "react";
import { StyleSheet, View } from "react-native";
import { WebView as RNWebView, type WebViewProps } from "react-native-webview";
import { isSafeWebUrl } from "../lib/preview";
import { colors, radius } from "../theme";
import { ErrorBanner, Loading } from "./ui";

// react-native-webview 14.0.1 declares `class WebView<P = undefined> extends Component<WebViewProps & P>`,
// which collapses to `never` props under current TypeScript; use the props type it intends.
const WebView = RNWebView as unknown as ComponentType<WebViewProps>;

export interface WebPreviewProps {
  url: string;
  reloadKey: number;
  labels: { loading: string; blocked: string; failed: string };
}

/** Native WebView for web-project previews. Only http(s) navigations are allowed. */
export function WebPreview({ url, reloadKey, labels }: WebPreviewProps) {
  const [blocked, setBlocked] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <View style={styles.wrap}>
      {blocked ? <ErrorBanner message={labels.blocked} /> : null}
      {failed ? <ErrorBanner message={labels.failed} /> : null}
      <WebView
        key={reloadKey}
        source={{ uri: url }}
        style={styles.web}
        originWhitelist={["http://*", "https://*"]}
        onShouldStartLoadWithRequest={(req) => {
          const ok = isSafeWebUrl(req.url);
          if (!ok) setBlocked(true);
          return ok;
        }}
        onLoadStart={() => setFailed(false)}
        onError={() => setFailed(true)}
        onHttpError={(e) => {
          if (e.nativeEvent.statusCode >= 500) setFailed(true);
        }}
        startInLoadingState
        renderLoading={() => <Loading label={labels.loading} />}
        allowsBackForwardNavigationGestures
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        allowFileAccess={false}
        accessibilityLabel={url}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, gap: 8 },
  web: { flex: 1, borderRadius: radius.md, backgroundColor: colors.surface },
});
