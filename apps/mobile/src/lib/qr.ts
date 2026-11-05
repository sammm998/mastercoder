import QRCode from "qrcode";

/** QR module matrix for `text` (true = dark), rendered by the app with react-native-svg. */
export function qrMatrix(text: string, errorCorrectionLevel: "L" | "M" | "Q" | "H" = "M"): boolean[][] {
  const qr = QRCode.create(text, { errorCorrectionLevel });
  const size = qr.modules.size;
  const rows: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x++) row.push(qr.modules.get(y, x) === 1);
    rows.push(row);
  }
  return rows;
}

/**
 * One SVG path for all dark modules (fast to render; one element instead of size² rects).
 * Coordinates are in module units; `quiet` adds the standard quiet zone.
 */
export function qrPath(matrix: boolean[][], quiet = 4): { d: string; size: number } {
  const n = matrix.length;
  let d = "";
  for (let y = 0; y < n; y++) {
    const row = matrix[y] ?? [];
    let x = 0;
    while (x < n) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < n && row[x]) x++;
      d += `M${start + quiet} ${y + quiet}h${x - start}v1h${start - x}z`;
    }
  }
  return { d, size: n + quiet * 2 };
}
