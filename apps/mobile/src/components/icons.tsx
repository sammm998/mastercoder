import Svg, { Circle, Path, Rect } from "react-native-svg";
import { colors } from "../theme";

/** Small stroke icons (decorative: the pressable around them carries the accessibility label). */
type P = { size?: number; color?: string };

export function MicIcon({ size = 22, color = colors.text }: P) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Rect x={9} y={3} width={6} height={11} rx={3} stroke={color} strokeWidth={2} />
      <Path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

export function StopIcon({ size = 22, color = colors.text }: P) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Rect x={6} y={6} width={12} height={12} rx={2} fill={color} />
    </Svg>
  );
}

export function RecordDot({ size = 22, color = colors.danger }: P) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Circle cx={12} cy={12} r={7} fill={color} />
    </Svg>
  );
}

export function PauseIcon({ size = 22, color = colors.text }: P) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Rect x={6} y={5} width={4} height={14} rx={1} fill={color} />
      <Rect x={14} y={5} width={4} height={14} rx={1} fill={color} />
    </Svg>
  );
}
