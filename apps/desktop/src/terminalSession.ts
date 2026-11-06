/** Report a failed session creation to the user and allow a later retry. */
export async function createTerminalSession(
  create: () => Promise<void>,
  setError: (message: string | null) => void,
): Promise<void> {
  setError(null);
  try {
    await create();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}
