/**
 * Lightweight setup entry point — used during channel onboarding and config
 * repair flows where the full runtime is not available or needed.
 */
import { buildChannel } from "./channel.js";

export default {
  id: "chatzoo",
  name: "ChatZoo",
  description:
    "Connects OpenClaw to the ChatZoo iOS app via event-driven webhooks",
  // Config schema is loaded from openclaw.plugin.json manifest
  plugin: buildChannel(),
};
