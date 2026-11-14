import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TripSplit 旅游分账助手",
    short_name: "TripSplit",
    description: "多人自由行 AA 记账助手：多模态录入、账目检索、核账、最少转账结算。",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f5f9",
    theme_color: "#4338ca",
    lang: "zh-CN",
    icons: [
      { src: "/icon", sizes: "64x64", type: "image/png" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
