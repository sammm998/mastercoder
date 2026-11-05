import { createElement } from "react";
import { View } from "react-native";
import { isSafeWebUrl } from "../lib/preview";
import { ErrorBanner } from "./ui";
import type { WebPreviewProps } from "./WebPreview";

/** Web build: react-native-webview has no web implementation, so render a sandboxed iframe. */
export function WebPreview({ url, reloadKey, labels }: WebPreviewProps) {
  if (!isSafeWebUrl(url)) return <ErrorBanner message={labels.blocked} />;
  return (
    <View style={{ flex: 1 }}>
      {createElement("iframe", {
        key: reloadKey,
        src: url,
        title: url,
        sandbox: "allow-scripts allow-same-origin allow-forms",
        referrerPolicy: "no-referrer",
        style: { border: 0, width: "100%", height: "100%", borderRadius: 10, background: "#171613" },
      })}
    </View>
  );
}
