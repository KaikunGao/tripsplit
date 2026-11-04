import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** iOS 添加到主屏幕用的图标（系统自行裁圆角，所以这里铺满）。 */
export default function AppleIcon() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#4338ca", color: "#fff", fontSize: 110, fontWeight: 700, fontFamily: "system-ui, sans-serif" }}>T</div>,
    size,
  );
}
