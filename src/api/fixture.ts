import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { launch, LaunchOptions, Emulator } from "./index";

/** Run a test with automatic teardown. Failures can save screenshots, state and serial output. */
export async function withEmulator<T>(
  options: LaunchOptions,
  test: (emulator: Emulator) => Promise<T>,
  artifacts: { directory?: string } = {},
): Promise<T> {
  const emulator = await launch(options);
  let failed = false;
  let failure: unknown;
  let result!: T;
  try {
    result = await test(emulator);
  } catch (error) {
    failed = true;
    failure = error;
    // Artifact failures must not hide the original assertion or emulator failure.
    if (artifacts.directory) {
      try {
        await mkdir(artifacts.directory, { recursive: true });
        const dir = await mkdtemp(join(artifacts.directory, "puae-failure-"));
        await writeFile(
          join(dir, "failure.txt"),
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
        );
        const save = async (name: string, capture: () => Promise<string>) => {
          try {
            await writeFile(join(dir, name), await capture());
          } catch (failure) {
            await writeFile(join(dir, name + ".error.txt"), String(failure));
          }
        };
        try {
          await emulator.screenshot({ path: join(dir, "screen.png") });
        } catch (failure) {
          await writeFile(join(dir, "screen.error.txt"), String(failure));
        }
        await save("state.json", async () =>
          JSON.stringify(await emulator.inspect(), null, 2),
        );
        await save(
          "serial.txt",
          async () => (await emulator.serial.read()).text,
        );
        options.log?.(`Failure artifacts: ${dir}`);
      } catch {
        /* preserve the original error */
      }
    }
  }
  try {
    await emulator.close();
  } catch (error) {
    if (options.isolate !== false) await emulator.terminate();
    if (!failed) throw error;
  }
  if (failed) throw failure;
  return result;
}
