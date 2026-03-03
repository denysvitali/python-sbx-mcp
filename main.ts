import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pyodideModule from "pyodide/pyodide.js";

// --- Load Pyodide (one-time, before MCP connects) ---
console.error("Loading Pyodide...");

// Detect embedded assets (compiled binary) vs dev mode (npm cache).
// During compilation, .wasm is renamed to .wasm.bin so Deno doesn't try to
// resolve it as a WASM module. At runtime we copy assets to a temp dir,
// restoring the original filename.
let indexURL: string | undefined;
try {
  const assetsDir = import.meta.dirname + "/pyodide-assets/";
  Deno.statSync(assetsDir + "pyodide.asm.wasm.bin");
  const tmpDir = Deno.makeTempDirSync({ prefix: "pyodide-" });
  for (const entry of Deno.readDirSync(assetsDir)) {
    const destName = entry.name.endsWith(".wasm.bin")
      ? entry.name.replace(/\.wasm\.bin$/, ".wasm")
      : entry.name;
    Deno.copyFileSync(assetsDir + entry.name, tmpDir + "/" + destName);
  }
  indexURL = tmpDir + "/";
  console.error("Using embedded Pyodide assets from", tmpDir);
} catch {
  // Dev mode — let Pyodide resolve from npm cache
}

const pyodide = await pyodideModule.loadPyodide({
  ...(indexURL && { indexURL }),
  stdout: (text: string) => console.error("[pyodide:stdout]", text),
  stderr: (text: string) => console.error("[pyodide:stderr]", text),
});

// Redirect Python stdout/stderr to StringIO so print() doesn't corrupt the MCP JSON-RPC stream
pyodide.runPython(`
import sys, io
__stdout_capture = io.StringIO()
__stderr_capture = io.StringIO()
sys.stdout = __stdout_capture
sys.stderr = __stderr_capture
`);

// Load micropip for package installation
await pyodide.loadPackage("micropip", {
  messageCallback: (msg: string) => console.error(msg),
});
const micropip = pyodide.pyimport("micropip");

console.error("Pyodide ready.");

// --- MCP Server ---
const server = new McpServer({
  name: "python-sandbox",
  version: "1.0.0",
});

server.tool(
  "execute_python",
  "Execute Python code in a Pyodide (WASM) sandbox. Returns the expression result or captured stdout.",
  {
    code: z.string().describe("Python code to execute"),
    pip_packages: z
      .string()
      .optional()
      .describe("Comma-separated package names to install via micropip before execution"),
  },
  async ({ code, pip_packages }) => {
    try {
      // Install packages if requested
      if (pip_packages) {
        const packages = pip_packages.split(",").map((p) => p.trim()).filter(Boolean);
        for (const pkg of packages) {
          console.error(`Installing ${pkg}...`);
          await micropip.install(pkg);
        }
      }

      // Reset capture buffers
      pyodide.runPython(`
__stdout_capture.truncate(0)
__stdout_capture.seek(0)
__stderr_capture.truncate(0)
__stderr_capture.seek(0)
`);

      // Execute the code
      const result = await pyodide.runPythonAsync(code);

      // Collect captured output
      const stdout = pyodide.runPython("__stdout_capture.getvalue()");
      const stderr = pyodide.runPython("__stderr_capture.getvalue()");

      // Expression result takes priority; fall back to stdout
      let text: string;
      if (result !== undefined && result !== null) {
        text = String(result);
      } else if (stdout) {
        text = stdout;
      } else {
        text = stderr || "";
      }

      return { content: [{ type: "text" as const, text }] };
    } catch (err: unknown) {
      // PythonError.message is empty when sys.stderr is redirected;
      // the traceback lands in our stderr capture buffer instead
      const captured = pyodide.runPython("__stderr_capture.getvalue()") as string;
      const message = captured
        || (err instanceof Error ? err.message : "")
        || String(err);
      return { content: [{ type: "text" as const, text: message }], isError: true };
    }
  },
);

// --- Connect via stdio ---
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP server running on stdio.");
