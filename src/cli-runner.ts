import { spawn } from 'child_process';
import { ProviderConfig, CliResult } from './types.js';

/**
 * Runs a CLI provider with the given message and optional session resume.
 */
export async function runCli(
  provider: ProviderConfig,
  message: string,
  sessionId?: string,
  extraArgs: string[] = [],
): Promise<CliResult> {
  // Build args carefully: for CLIs like `claude -p "msg"`, the message
  // must come right after the print flag. So we insert the message into
  // the correct position rather than always appending.
  const args: string[] = [];

  if (provider.messageFlag === 'positional') {
    // Find the print flag (e.g. "-p") in baseArgs and insert message after it
    const baseArgs = [...provider.baseArgs];
    const printFlagIdx = baseArgs.findIndex(a => a === '-p' || a === '--print');
    if (printFlagIdx !== -1) {
      // Insert message right after the print flag
      baseArgs.splice(printFlagIdx + 1, 0, message);
      args.push(...baseArgs);
    } else {
      // No print flag — just append message at the end
      args.push(...baseArgs, message);
    }
  } else if (provider.messageFlag === 'stdin') {
    args.push(...provider.baseArgs);
  } else {
    // Custom flag like "--message"
    args.push(...provider.baseArgs, provider.messageFlag, message);
  }

  args.push(...extraArgs);

  // Add session resume if supported and available
  if (sessionId && provider.resumeFlag) {
    args.push(provider.resumeFlag, sessionId);
  }

  const startTime = Date.now();

  return new Promise<CliResult>((resolve, reject) => {
    const proc = spawn(provider.command, args, {
      cwd: provider.cwd || process.cwd(),
      env: { ...process.env, ...provider.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: provider.timeout || 600_000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // If using stdin mode, write the message and close.
    // Otherwise, close stdin immediately so the CLI doesn't wait for input.
    if (provider.messageFlag === 'stdin') {
      proc.stdin.write(message);
    }
    proc.stdin.end();

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ${provider.command}: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      const durationMs = Date.now() - startTime;
      const exitCode = code ?? 1;

      // Detect timeout kill (SIGTERM = exit 143)
      if (signal === 'SIGTERM' || exitCode === 143) {
        const timeoutSec = Math.round((provider.timeout || 600_000) / 1000);
        resolve({
          response: `⏱ Timed out after ${timeoutSec}s. The task was too complex for a single turn — try breaking it into smaller steps, or increase the provider timeout.`,
          exitCode,
          durationMs,
          timedOut: true,
        });
        return;
      }

      try {
        const result = parseOutput(provider, stdout, stderr);
        resolve({ ...result, exitCode, durationMs });
      } catch (err) {
        // If parsing fails, return raw stdout as response
        resolve({
          response: stdout.trim() || stderr.trim() || `CLI exited with code ${exitCode}`,
          exitCode,
          durationMs,
        });
      }
    });
  });
}

/**
 * Parse CLI output based on provider configuration.
 */
function parseOutput(
  provider: ProviderConfig,
  stdout: string,
  _stderr: string,
): Pick<CliResult, 'response' | 'sessionId'> {
  if (provider.outputFormat === 'json') {
    // stdout may contain non-JSON lines before the JSON object — find the JSON
    const jsonStart = stdout.indexOf('{');
    const jsonStr = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
    const json = JSON.parse(jsonStr);
    const response = provider.responsePath
      ? getNestedValue(json, provider.responsePath)
      : JSON.stringify(json);
    const sessionId = provider.sessionIdPath
      ? getNestedValue(json, provider.sessionIdPath)
      : undefined;
    return {
      response: response != null ? String(response) : '',
      sessionId: sessionId != null ? String(sessionId) : undefined,
    };
  }

  if (provider.outputFormat === 'stream-json') {
    // Parse newline-delimited JSON, extract text deltas
    const lines = stdout.trim().split('\n');
    let response = '';
    let sessionId: string | undefined;

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (provider.responsePath) {
          const text = getNestedValue(event, provider.responsePath);
          if (text) response += text;
        }
        if (provider.sessionIdPath) {
          const sid = getNestedValue(event, provider.sessionIdPath);
          if (sid) sessionId = String(sid);
        }
      } catch {
        // skip malformed lines
      }
    }

    return { response: response || stdout.trim(), sessionId };
  }

  // Plain text
  return { response: stdout.trim() };
}

function getNestedValue(obj: unknown, path: string): unknown {
  return path.split('.').reduce((acc: unknown, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}
