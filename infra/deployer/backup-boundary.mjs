export function safeBackupKey(key) {
  return (
    typeof key === 'string' &&
    /^(?:content\/|sites\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/content\/)/.test(
      key,
    ) &&
    !/[\\\x00-\x1f\x7f]/.test(key) &&
    !key.split('/').some((part) => part === '..' || part === '.' || part === '')
  );
}
