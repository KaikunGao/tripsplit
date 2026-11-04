import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

/** 站点 favicon：靛蓝圆角方块 + 白色 T，与顶栏 logo 一致。 */
export default function Icon() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#4338ca", borderRadius: 16, color: "#fff", fontSize: 40, fontWeight: 700, fontFamily: "system-ui, sans-serif" }}>T</div>,
    size,
  );
}
