import { z } from "zod"

const Env = z.object({
  PORT: z.coerce.number().int().default(3000),
  PB_URL: z.string().url().default("http://127.0.0.1:8090"),
  PB_SUPERUSER_EMAIL: z.string().email(),
  PB_SUPERUSER_PASSWORD: z.string().min(10),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  DATA_DIR: z.string().default("/data"),
  DISPLAY: z.string().default(":99"),
  NOVNC_DIR: z.string().default("/opt/novnc"),
  VNC_WS_PORT: z.coerce.number().int().default(6080),
  /** Size of the virtual screen and the Chromium window. Keep in step with SCREEN in the entrypoint. */
  SCREEN_WIDTH: z.coerce.number().int().min(320).default(1920),
  SCREEN_HEIGHT: z.coerce.number().int().min(320).default(1080),
  /** noVNC zlib compression 0 to 9. JPEG quality follows the chosen stream resolution. */
  VNC_COMPRESSION: z.coerce.number().int().min(0).max(9).default(6),
  MCP_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || v.length >= 32, "MCP_TOKEN must be at least 32 characters"),
  ALLOWED_EMAILS: z.string().default(""),
  COOKIE_SECURE: z.enum(["true", "false"]).default("true"),
  /** Time zone used to evaluate job cron schedules. */
  SCHEDULE_TZ: z.string().default("Asia/Seoul"),
})

export const env = Env.parse(process.env)

export const allowedEmails = new Set(
  env.ALLOWED_EMAILS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
)
