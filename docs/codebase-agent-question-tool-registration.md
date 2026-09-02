# Question for Codebase Agent (Codepulse) — Client-Local Tool Registration

> Status: **Answered — definitively confirmed against backend source (2026-08-12)**
> Last updated: 2026-08-12
> Related: `docs/ai-chat-local-context.md`

---

## Why this question exists

While testing pipeline creation through the Harness AI Chat, we observed real
`assistant_tool_request` / `assistant_tool_result` SSE events for
**backend-native tools** (`mcp__harness__harness_list`, `harness_get`,
`harness_create`) — the backend has a registered schema for these and calls
them itself.

Our own local capabilities (`list_files`, `read_file`) are **not** known to the
backend at all. We only inform the model about them via a freeform
`instructions_for_agent` + `available_local_commands` key inside the `context`
object — a flat, unschemed passthrough dict. Because the backend has no
registered schema for these, the model can only "call" them by writing plain
text in `assistant_message` that follows a format we asked for in the prompt.
There is no dedicated event type for this, because from the backend's point of
view it isn't a tool call at all — it's just text.

**The core question:** can our own hidden-context-declared tools plug into the
backend's *real* tool-calling infrastructure (the same one that produces
`assistant_tool_request`/`assistant_tool_result` for `harness_list` /
`harness_create`), or is free-text parsing genuinely the only option?

---

## Prompt to send

```
Context for you (Codepulse):

I'm building a VS Code extension on top of `POST /gateway/harness-intelligence/api/v2/chat`. I need to distinguish two very different things and I want to make sure I don't conflate them:

- **Backend-native tools** (e.g. `mcp__harness__harness_list`, `harness_get`, `harness_create`) — these are tools the backend/ml-infra already knows about, has a schema for, and calls itself. I observed these arrive to the client as real `assistant_tool_request` / `assistant_tool_result` SSE events during a pipeline-creation flow.
- **My own client-side "tools"** (e.g. `list_files`, `read_file` — local filesystem operations only my VS Code extension can perform) — these are **not known to the backend at all**. I'm only informing the model about them via a freeform `instructions_for_agent` + `available_local_commands` key inside the `context` object (which I've already confirmed is a flat, unschemed passthrough dict — see prior findings below). Because the backend has no registered schema for these, the model can only "call" them by writing plain text in `assistant_message` that follows a format I asked for in the prompt — there is no dedicated event type for this, because from the backend's point of view it isn't a tool call, it's just text.

What I actually want to know: is there any way to make **my own hidden-context-declared tools** (`list_files`, `read_file`, or any other local capability I want to expose) plug into the backend's **real** tool-calling infrastructure — the same one that produces `assistant_tool_request`/`assistant_tool_result` for `harness_list`/`harness_create` — so that when the model wants to use my tool, the backend emits a proper structured tool-call event (with args/result) instead of me having to regex/parse free text out of `assistant_message`?

Prior findings you already gave me (please don't re-derive, just use as ground truth unless you find they're wrong):
- `ChatV2.Context` is `map[string]interface{}` — a flat passthrough dict. No typed slot for declaring client tools exists (`types/chat.go:52`, handler `chat_v2.go:137-214` only injects `is_v2` and `selected_connector_ids` itself).
- You previously said `assistant_tool_request`/`assistant_tool_result` are in `skippableEventTypes` (`chat.go:146`) and get stripped — but I captured **both event types actually arriving at the client** in a live SSE response during a `harness_create` flow. Please re-verify this against source; the skip-list claim appears wrong for at least this path.
- MCP connectors (`selected_connector_ids`) are the backend's sanctioned tool-registration path, but they must be **network-reachable from ml-infra**, not from my local machine — so I can't register a local MCP server this way.

Specific questions — please cite exact file/line in `harness-intelligence` (Go) and, if visible, the ml-infra/genai-service tool-registration schema:

1. Is there **any mechanism at all** — via `context`, a query param, an account/project setting, or elsewhere — to register a **client-defined tool** (name + description + JSON schema for its arguments) such that the backend's LLM orchestration treats it as a real callable tool (i.e. it would appear in the same tool list as `harness_list`, and the backend would emit `assistant_tool_request` when the model wants to call it)?
2. If the answer to #1 is no for `/v2/chat`, is there a **different** endpoint (e.g. a raw/direct model-access endpoint, or something in `/agent/run`) where **arbitrary client tool definitions** (BYO tool schema, like OpenAI/Anthropic function-calling) are actually supported?
3. Given that `assistant_tool_request`/`assistant_tool_result` clearly do reach the client for backend-native tools (contradicting the earlier skip-list claim) — is that event pair considered a **stable client-facing contract**, or internal plumbing from ml-infra that just happens to leak through? I'm asking because if it's stable, I at least want to build my own tool-call UI to visually match it, even if I can't register into it directly.
4. Is MCP connector registration (`selected_connector_ids`) **only** for network-reachable servers, or is there any variant (e.g. a manifest, a stdio bridge, a relay) that Harness supports for tools that must execute on the **end user's local machine** rather than a server?
5. **Bottom line:** is "prompt-engineer a fake tool via `context`, parse free text, execute locally, feed result back as the next turn" (what I'm prototyping) genuinely the *only* option today for a client-local tool, or is there a real registration path I'm missing?
```

---

## Answer (received 2026-08-12) — grounded in actual source

Codepulse now had direct access to `harness-code/intelligence/api/controller/aiagent/types/chat.go`
and the capability registry implementation. Answer: **no registration path exists.**
Freeform prose description + client-side text parsing is the only option today.

**The `ChatV2` struct, verbatim as reported:**

```
type ChatV2 struct {
    ConversationID, InteractionID uuid.UUID
    Prompt         string
    Metadata       map[string]string
    Conversation   []Conversation
    Stream         bool
    Mode           enum.AgentMode
    Attachments    []AttachmentRef
    Context        map[string]interface{}
    SystemEvent    *SystemEvent
}
```

No `tools`, `functions`, or `capabilities` field anywhere. `Context`/`Metadata`
are free-form maps, but the server only reads specific known keys out of them
(`action`, `stage_type`, `module`, …) — it does not scan for tool definitions.

**Why backend tools can't be extended per-request:** backend-native tools are a
Go-side **capability registry** (`intelligence/api/service/capabilities/capabilities.go`)
— a `map[capabilities.Type]capabilities.Capability` populated at **server
startup** via explicit `register()` calls wired through Wire
(`intelligence/api/controller/capabilities/wire.go`, plus concrete capability
files like `get_file.go`, `list_files.go`, `display_yaml.go`). Each capability
has a compiled Go type, an input/output schema, and logic baked into the
binary. **There is no runtime API to add an entry to that map from an incoming
request** — it's fixed at build/deploy time by the Intelligence team.

**Naming discrepancy to note:** Codepulse calls the backend-tool SSE event
`capability_execution`. In our own live capture (§2.3/§8 of
`ai-chat-local-context.md`) we observed `assistant_tool_request` /
`assistant_tool_result` for the same kind of backend tool calls
(`harness_list`, `harness_get`, `harness_create`). Either these are two
different event families, the event was renamed, or one report has a naming
slip. Not resolved — flag if it matters later, e.g. before building any UI that
keys off a specific event name.

**Answers to the four questions, as given:**

| # | Question | Answer |
|---|----------|--------|
| 1 | Register a tool via payload/setting? | No — no such field exists in the request schema or anywhere the handler reads. |
| 2 | Another endpoint with BYO-tools/function-calling? | No — `/api/v2/chat` is the only chat endpoint in this codebase; none of it supports arbitrary tool schemas. |
| 3 | Can client-machine-only tools specifically be registered? | No — since there's no registration path at all, there's no separate path for "runs on the user's machine" tools either. |
| 4 | Is prose + text parsing the only option? | Yes, based on what's implemented today. |

**Path to change this (not achievable client-side):** would require the
Intelligence/AI platform team (owners of
`intelligence/api/service/capabilities`) to add a per-request "external tool
declarations" concept to `ChatV2`, and teach agent orchestration to emit
`capability_execution`-style events for tool names it doesn't recognize as
backend-native — deferring execution back to the client instead of running
`Registry.Execute` itself. This is a real backend feature request, not
something achievable from the client today.

## Conclusion — fold into `docs/ai-chat-local-context.md`

This is now the **final, structural confirmation** (not inference from
behavior, but the actual struct + registry design) that free-text parsing via
`context`-injected prose is the only viable mechanism for client-local tools.
§4.2 (Agentic command loop design) in `ai-chat-local-context.md` should be
updated to cite this as settled, with no remaining open question about a
"real" registration path.
