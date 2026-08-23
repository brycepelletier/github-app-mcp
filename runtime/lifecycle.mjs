const CONTAINER_NAME_PART = /^[a-z0-9][a-z0-9_.-]*$/;

export function officialContainerName(processId, nonce) {
  const pid = String(processId);
  const safeNonce = String(nonce).toLowerCase();
  if (!/^\d+$/.test(pid) || !CONTAINER_NAME_PART.test(safeNonce)) {
    throw new Error("Invalid official-container identity.");
  }
  return `github-app-mcp-official-${pid}-${safeNonce}`;
}

export function createOfficialContainerCleanup({
  getTransport,
  clearTransport,
  removeContainer,
}) {
  let cleanupPromise;

  return function cleanupOfficialContainer() {
    if (cleanupPromise) return cleanupPromise;

    cleanupPromise = (async () => {
      const transport = getTransport();
      clearTransport();

      try {
        await transport?.close();
      } catch {
        // Explicit container removal below is the authoritative fallback.
      }

      try {
        await removeContainer();
      } catch {
        // The container may already have exited and been removed by --rm.
      }
    })().finally(() => {
      cleanupPromise = undefined;
    });

    return cleanupPromise;
  };
}
