import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache: there are no ISR pages, every API call is dynamic.
export default defineCloudflareConfig({});
