/**
 * Wire format of the /api/copilot response. It is still a plain-text token stream; the tool-calling
 * agent adds control lines so the UI can show which tools ran. A control line is
 * `\x1e<command>\n` (\x1e = ASCII record separator, which never occurs in model prose):
 *
 *   \x1etool:<name>\n   a tool was executed
 *   \x1ereset\n         discard the answer text so far (the model wrote a preamble, then called a tool)
 *   \x1efallback\n      discard the text and the tool trace (the agent failed; the snapshot answer follows)
 *
 * A response without control lines (snapshot path, demo message) parses to itself.
 * No server imports here: the browser widget uses `parseWire`.
 */
export const MARK = "\x1e";

export const wireTool = (name: string) => `${MARK}tool:${name.replace(/[^a-z0-9_]/gi, "")}\n`;
export const WIRE_RESET = `${MARK}reset\n`;
export const WIRE_FALLBACK = `${MARK}fallback\n`;

export interface WireState { text: string; tools: string[] }

/** Parse everything received so far. Safe on a partial stream: an unfinished control line is ignored until it completes. */
export function parseWire(acc: string): WireState {
  const parts = acc.split(MARK);
  let text = parts[0];
  let tools: string[] = [];
  for (const part of parts.slice(1)) {
    const nl = part.indexOf("\n");
    if (nl < 0) break; // control line still arriving
    const cmd = part.slice(0, nl);
    if (cmd === "reset") text = "";
    else if (cmd === "fallback") { text = ""; tools = []; }
    else if (cmd.startsWith("tool:")) { const name = cmd.slice(5); if (name && !tools.includes(name)) tools.push(name); }
    text += part.slice(nl + 1);
  }
  return { text, tools };
}

/** "get_cash_forecast" → "cash forecast" for the "used:" trace. */
export const toolLabel = (name: string) => name.replace(/^(get|search)_/, (m) => (m === "search_" ? "search " : "")).replace(/_/g, " ");
