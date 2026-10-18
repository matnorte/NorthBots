import { z } from "zod";

export const Email = z.string().trim().toLowerCase().email().max(254);
export const Password = z.string().min(10).max(256);

export const SignupBody = z.object({
  email: Email,
  password: Password,
  workspaceName: z.string().trim().min(1).max(80).optional(),
});

export const LoginBody = z.object({ email: Email, password: z.string().min(1).max(256) });

export const Me = z.object({
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  email: z.string(),
});
export type Me = z.infer<typeof Me>;

export const ErrorBody = z.object({ error: z.string(), message: z.string() });

export const WorkspaceSettings = z.object({
  name: z.string().min(1).max(80),
  timezone: z.string(),
  locale: z.enum(["en", "pt-BR", "es"]),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

export const SecretName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,63}$/, "use UPPER_SNAKE_CASE, 2 to 64 chars");

export const PutSecretBody = z.object({ name: SecretName, value: z.string().min(1).max(65536) });

/** What the API exposes about a secret: never its value. */
export const SecretInfo = z.object({
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const UseSecretBody = z.object({
  sandboxId: z.string().min(1),
  as: z.enum(["env", "file"]),
  target: z.string().min(1).max(256),
});
