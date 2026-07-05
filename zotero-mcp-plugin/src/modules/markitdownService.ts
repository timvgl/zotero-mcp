/**
 * markitdownService.ts
 *
 * Converts PDF attachments to Markdown using the external `markitdown` CLI
 * (https://github.com/microsoft/markitdown) so that AI clients receive
 * Markdown instead of raw extracted PDF text.
 *
 * - The converted .md file is stored next to the PDF and reused on later reads.
 * - If Python/markitdown is not installed the plugin keeps working with the
 *   built-in PDF extraction; the user gets a single, small, auto-closing
 *   notice per session.
 */

import { getPref } from "../utils/prefs";

declare const Zotero: any;
declare const IOUtils: any;
declare const ChromeUtils: any;
declare const Services: any;
declare const ztoolkit: ZToolkit;

const PROBE_TIMEOUT_MS = 20000;
const CONVERT_TIMEOUT_MS = 120000;
const TOAST_DEDUPE_MS = 5000;

interface ResolvedCommand {
  /** Absolute path to the executable (markitdown or python). */
  command: string;
  /** Extra leading arguments, e.g. ["-m", "markitdown"] when using python. */
  argsPrefix: string[];
}

interface RunResult {
  success: boolean;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

export interface MarkdownResult {
  markdown: string;
  mdPath: string;
  /** true when the file was converted during this call, false when an existing .md was reused */
  converted: boolean;
}

export interface GetMarkdownOptions {
  /** When false, only an already existing .md file is used; no conversion is started. */
  convertIfMissing?: boolean;
  /** When false, no toast is shown for this read (used by bulk operations like fulltext search). */
  notify?: boolean;
}

class MarkitdownService {
  /** undefined = not resolved yet, null = resolved but unavailable */
  private resolved: ResolvedCommand | null | undefined;
  private resolving: Promise<ResolvedCommand | null> | null = null;
  private inFlight = new Map<string, Promise<MarkdownResult | null>>();
  private unavailableNotified = false;
  private conversionFailureNotified = false;
  private lastToast = { message: "", time: 0 };

  /**
   * Get the Markdown version of a PDF. Reuses an existing .md file next to
   * the PDF, otherwise converts via markitdown (unless convertIfMissing is
   * false). Returns null when Markdown is not available for any reason —
   * callers must fall back to their regular PDF extraction.
   */
  public async getMarkdownForPDF(
    pdfPath: string,
    options: GetMarkdownOptions = {},
  ): Promise<MarkdownResult | null> {
    const { convertIfMissing = true, notify = true } = options;
    try {
      if (!pdfPath || getPref("markitdown.enabled") === false) {
        return null;
      }

      const mdPath = this.getMarkdownPath(pdfPath);

      // Reuse an existing conversion
      if (await this.fileExists(mdPath)) {
        const markdown = await this.readMarkdown(mdPath);
        if (markdown && markdown.trim().length > 0) {
          ztoolkit.log(`[Markitdown] Using existing Markdown file: ${mdPath}`);
          if (notify) {
            this.showToast(
              `Reading Markdown instead of PDF: ${this.basename(mdPath)}`,
            );
          }
          return { markdown, mdPath, converted: false };
        }
        ztoolkit.log(
          `[Markitdown] Existing Markdown file is empty, reconverting: ${mdPath}`,
          "warn",
        );
      }

      if (!convertIfMissing) {
        return null;
      }

      // Deduplicate concurrent conversions of the same PDF
      const running = this.inFlight.get(pdfPath);
      if (running) {
        return await running;
      }
      const promise = this.convertAndRead(pdfPath, mdPath, notify).finally(() =>
        this.inFlight.delete(pdfPath),
      );
      this.inFlight.set(pdfPath, promise);
      return await promise;
    } catch (error) {
      ztoolkit.log(
        `[Markitdown] Unexpected error for ${pdfPath}: ${error}`,
        "warn",
      );
      return null;
    }
  }

  private async convertAndRead(
    pdfPath: string,
    mdPath: string,
    notify: boolean,
  ): Promise<MarkdownResult | null> {
    const cmd = await this.getResolvedCommand();
    if (!cmd) {
      this.notifyUnavailableOnce();
      return null;
    }

    const subprocess = this.getSubprocess();
    if (!subprocess) {
      this.notifyUnavailableOnce();
      return null;
    }

    // Convert into a temp file first so a failed/partial conversion is never
    // mistaken for a valid cached .md file on the next read.
    const tmpPath = mdPath + ".tmp";
    try {
      const args = [...cmd.argsPrefix, pdfPath, "-o", tmpPath];
      ztoolkit.log(
        `[Markitdown] Converting PDF to Markdown: ${cmd.command} ${args.join(" ")}`,
      );
      if (notify) {
        this.showToast(`Converting PDF to Markdown: ${this.basename(pdfPath)}`);
      }

      const result = await this.run(
        subprocess,
        cmd.command,
        args,
        CONVERT_TIMEOUT_MS,
      );
      if (!result.success || !(await this.fileExists(tmpPath))) {
        ztoolkit.log(
          `[Markitdown] Conversion failed (exitCode=${result.exitCode}, timedOut=${result.timedOut}): ${result.output.substring(0, 2000)}`,
          "warn",
        );
        this.notifyConversionFailedOnce();
        return null;
      }

      const markdown = await this.readMarkdown(tmpPath);
      if (!markdown || markdown.trim().length === 0) {
        ztoolkit.log(
          `[Markitdown] Conversion produced an empty file for ${pdfPath}`,
          "warn",
        );
        this.notifyConversionFailedOnce();
        return null;
      }

      await IOUtils.move(tmpPath, mdPath);
      ztoolkit.log(
        `[Markitdown] Conversion succeeded: ${mdPath} (${markdown.length} chars)`,
      );
      if (notify) {
        this.showToast(
          `Reading Markdown instead of PDF: ${this.basename(mdPath)}`,
        );
      }
      return { markdown, mdPath, converted: true };
    } catch (error) {
      ztoolkit.log(
        `[Markitdown] Conversion error for ${pdfPath}: ${error}`,
        "warn",
      );
      this.notifyConversionFailedOnce();
      return null;
    } finally {
      // Best-effort cleanup of a leftover temp file
      try {
        if (await this.fileExists(tmpPath)) {
          await IOUtils.remove(tmpPath);
        }
      } catch (cleanupError) {
        ztoolkit.log(
          `[Markitdown] Could not remove temp file ${tmpPath}: ${cleanupError}`,
          "warn",
        );
      }
    }
  }

  // ---------------------------------------------------------------------
  // Command resolution
  // ---------------------------------------------------------------------

  private async getResolvedCommand(): Promise<ResolvedCommand | null> {
    if (this.resolved !== undefined) {
      return this.resolved;
    }
    if (!this.resolving) {
      this.resolving = this.resolveCommand()
        .catch((error) => {
          ztoolkit.log(
            `[Markitdown] Error while locating markitdown: ${error}`,
            "warn",
          );
          return null;
        })
        .then((result) => {
          this.resolved = result;
          this.resolving = null;
          return result;
        });
    }
    return this.resolving;
  }

  private async resolveCommand(): Promise<ResolvedCommand | null> {
    const subprocess = this.getSubprocess();
    if (!subprocess) {
      return null;
    }

    const isWin = !!Zotero.isWin;

    // 1. Explicit path from preferences
    const prefPath = String(getPref("markitdown.path") || "").trim();
    if (prefPath) {
      if (await this.fileExists(prefPath)) {
        ztoolkit.log(`[Markitdown] Using configured executable: ${prefPath}`);
        return { command: prefPath, argsPrefix: [] };
      }
      ztoolkit.log(
        `[Markitdown] Configured markitdown.path does not exist: ${prefPath}`,
        "warn",
      );
    }

    // 2. markitdown on PATH
    for (const name of isWin
      ? ["markitdown.exe", "markitdown"]
      : ["markitdown"]) {
      const found = await this.pathSearch(subprocess, name);
      if (found) {
        ztoolkit.log(`[Markitdown] Found markitdown on PATH: ${found}`);
        return { command: found, argsPrefix: [] };
      }
    }

    // 3. Common install locations that are not on the PATH of GUI apps
    for (const candidate of this.getCandidatePaths(isWin)) {
      if (await this.fileExists(candidate)) {
        ztoolkit.log(`[Markitdown] Found markitdown at: ${candidate}`);
        return { command: candidate, argsPrefix: [] };
      }
    }

    // 4. Fall back to `python -m markitdown` (covers pip installs whose
    //    Scripts/bin directory is not on the PATH)
    const pythonNames = isWin
      ? ["python.exe", "python3.exe", "py.exe"]
      : ["python3", "python"];
    for (const name of pythonNames) {
      const python = await this.pathSearch(subprocess, name);
      if (!python) {
        continue;
      }
      const probe = await this.run(
        subprocess,
        python,
        ["-c", "import markitdown"],
        PROBE_TIMEOUT_MS,
      );
      if (probe.success) {
        ztoolkit.log(`[Markitdown] Using python module via: ${python}`);
        return { command: python, argsPrefix: ["-m", "markitdown"] };
      }
    }

    ztoolkit.log(
      "[Markitdown] markitdown not found (neither CLI nor python module)",
      "warn",
    );
    return null;
  }

  private getCandidatePaths(isWin: boolean): string[] {
    const candidates: string[] = [];
    const home = this.getEnv(isWin ? "USERPROFILE" : "HOME");
    if (isWin) {
      if (home) {
        candidates.push(
          `${home}\\AppData\\Local\\Programs\\Python\\Scripts\\markitdown.exe`,
        );
      }
    } else {
      candidates.push(
        "/opt/homebrew/bin/markitdown",
        "/usr/local/bin/markitdown",
        "/usr/bin/markitdown",
      );
      if (home) {
        candidates.push(`${home}/.local/bin/markitdown`);
      }
    }
    return candidates;
  }

  // ---------------------------------------------------------------------
  // Process helpers
  // ---------------------------------------------------------------------

  private getSubprocess(): any | null {
    try {
      return ChromeUtils.importESModule(
        "resource://gre/modules/Subprocess.sys.mjs",
      ).Subprocess;
    } catch (esmError) {
      try {
        return ChromeUtils.import("resource://gre/modules/Subprocess.jsm")
          .Subprocess;
      } catch (jsmError) {
        ztoolkit.log(
          `[Markitdown] Subprocess module unavailable: ${jsmError}`,
          "warn",
        );
        return null;
      }
    }
  }

  private async pathSearch(
    subprocess: any,
    name: string,
  ): Promise<string | null> {
    try {
      const found = await subprocess.pathSearch(name);
      return found || null;
    } catch (error) {
      return null;
    }
  }

  private async run(
    subprocess: any,
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<RunResult> {
    let proc: any;
    try {
      proc = await subprocess.call({
        command,
        arguments: args,
        stderr: "stdout",
      });
    } catch (error) {
      return {
        success: false,
        exitCode: null,
        output: String(error),
        timedOut: false,
      };
    }

    // Drain stdout so the child process cannot block on a full pipe
    let output = "";
    const drain = (async () => {
      try {
        let chunk: string;
        while ((chunk = await proc.stdout.readString())) {
          output += chunk;
        }
      } catch (readError) {
        // Reading fails when the process is killed; the output so far is kept
      }
    })();

    let timeoutId: any;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    try {
      const waited = await Promise.race([proc.wait(), timeoutPromise]);
      if (waited === "timeout") {
        try {
          await proc.kill();
        } catch (killError) {
          ztoolkit.log(
            `[Markitdown] Failed to kill timed-out process: ${killError}`,
            "warn",
          );
        }
        return { success: false, exitCode: null, output, timedOut: true };
      }
      await drain;
      const exitCode = (waited as any)?.exitCode ?? null;
      return { success: exitCode === 0, exitCode, output, timedOut: false };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ---------------------------------------------------------------------
  // File and misc helpers
  // ---------------------------------------------------------------------

  private getMarkdownPath(pdfPath: string): string {
    return pdfPath.replace(/\.pdf$/i, "") + ".md";
  }

  private basename(path: string): string {
    return path.split(/[\\/]/).pop() || path;
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      return await IOUtils.exists(path);
    } catch (error) {
      return false;
    }
  }

  private async readMarkdown(path: string): Promise<string | null> {
    try {
      return await IOUtils.readUTF8(path);
    } catch (error) {
      ztoolkit.log(
        `[Markitdown] Could not read Markdown file ${path}: ${error}`,
        "warn",
      );
      return null;
    }
  }

  private getEnv(name: string): string {
    try {
      return Services.env.get(name) || "";
    } catch (error) {
      return "";
    }
  }

  // ---------------------------------------------------------------------
  // Notifications (small, auto-closing, deduplicated)
  // ---------------------------------------------------------------------

  private notifyUnavailableOnce(): void {
    if (this.unavailableNotified) {
      return;
    }
    this.unavailableNotified = true;
    this.showToast(
      "markitdown (Python) not found – using built-in PDF extraction. " +
        "Install it with 'pip install markitdown' to enable Markdown conversion.",
      5000,
    );
  }

  private notifyConversionFailedOnce(): void {
    if (this.conversionFailureNotified) {
      return;
    }
    this.conversionFailureNotified = true;
    this.showToast(
      "markitdown conversion failed – using built-in PDF extraction (details in debug log).",
      5000,
    );
  }

  private showToast(message: string, closeAfterMs = 3000): void {
    try {
      const now = Date.now();
      if (
        this.lastToast.message === message &&
        now - this.lastToast.time < TOAST_DEDUPE_MS
      ) {
        return;
      }
      this.lastToast = { message, time: now };

      const progressWin = new Zotero.ProgressWindow({ closeOnClick: true });
      progressWin.changeHeadline("Zotero MCP");
      progressWin.addDescription(message);
      progressWin.show();
      progressWin.startCloseTimer(closeAfterMs);
    } catch (error) {
      ztoolkit.log(
        `[Markitdown] Could not show notification: ${error}`,
        "warn",
      );
    }
  }
}

export const markitdownService = new MarkitdownService();
