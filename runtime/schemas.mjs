import { z } from "zod";

export const GIT_REMOTE_OPERATIONS = [
  "fetch", "pull", "push", "ls_remote", "auth_check", "push_dry_run",
];

export const gitRemoteSchema = z.object({
  operation: z.enum(GIT_REMOTE_OPERATIONS),
  remote: z.string().min(1).max(128).optional().default("origin"),
  branch: z.string().min(1).max(256).optional(),
}).strict().superRefine((value, context) => {
  if (value.operation === "push_dry_run" && !value.branch) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["branch"],
      message: "push_dry_run requires a branch",
    });
  }
});
