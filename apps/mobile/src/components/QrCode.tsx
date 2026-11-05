import { useMemo } from "react";
import { View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { qrMatrix, qrPath } from "../lib/qr";

/** QR code rendered as a single SVG path (dark modules on white, with the standard quiet zone). */
export function QrCode({ value, size = 240, label }: { value: string; size?: number; label: string }) {
  const { d, n } = useMemo(() => {
    const p = qrPath(qrMatrix(value, "M"));
    return { d: p.d, n: p.size };
  }, [value]);
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ width: size, height: size, borderRadius: 12, overflow: "hidden" }}>
      <Svg width={size} height={size} viewBox={`0 0 ${n} ${n}`}>
        <Rect x={0} y={0} width={n} height={n} fill="#FFFFFF" />
        <Path d={d} fill="#000000" />
      </Svg>
    </View>
  );
}
