export const ALWAYS_ALLOW = { type: 'always_allow' } as const;

export function alwaysAllowToolConfig<T extends string>(name: T) {
  return { name, enabled: true as const, permission_policy: ALWAYS_ALLOW };
}

export function alwaysAllowIdentityToolConfig() {
  return { enabled: true as const, permission_policy: ALWAYS_ALLOW };
}
