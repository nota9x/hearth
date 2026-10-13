export const hostnameMessage =
  'Enter a full hostname, such as images.example.com, without a protocol, port, or path.';
export function parseHostname(value: string) {
  const hostname = value.trim().toLowerCase();
  if (
    hostname.length > 253 ||
    !hostname.includes('.') ||
    hostname
      .split('.')
      .some(
        (label) =>
          !(
            label.length > 0 &&
            label.length <= 63 &&
            /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
          ),
      ) ||
    /^\d+$/.test(hostname.split('.').at(-1)!)
  )
    throw new Error(hostnameMessage);
  return hostname;
}

export const accessModes = ['everyone', 'administrators', 'selected'] as const;
export const domainHealthStates = [
  'pending',
  'active',
  'misconfigured',
  'unhealthy',
] as const;
export const domainStatusLabels = {
  pending: 'Pending validation',
  active: 'Active',
  misconfigured: 'Misconfigured',
  unhealthy: 'Unhealthy',
  disabled: 'Disabled',
};
export const accessModeLabels = {
  everyone: 'Everyone',
  administrators: 'Administrators only',
  selected: 'Selected members',
};

export function isPublicHostname(hostname: string) {
  return !/\.(?:localhost|local|internal|lan|test|invalid|example)$/.test(
    hostname,
  );
}
