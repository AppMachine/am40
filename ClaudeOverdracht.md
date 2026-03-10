# Claude Code Provider - Overdracht Document

Dit document beschrijft alle wijzigingen die zijn aangebracht om de Claude Code provider werkend te krijgen in T5 Conductor (valencia-v2). Gebruik dit als referentie bij verdere ontwikkeling.

---

## Samenvatting

De Claude Code provider was geregistreerd in het systeem maar werkte end-to-end niet. Er waren **5 bugs** verspreid over frontend, backend routing, session persistence en CLI integratie. Alle bugs hadden hetzelfde patroon: hardcoded `"codex"`-only checks die `"claude-code"` negeerden.

---

## Bug 1: Frontend - `normalizeProviderKind` verwierp `"claude-code"`

**Bestand:** `apps/web/src/composerDraftStore.ts:210-212`

**Probleem:** De functie die provider-selectie persisteert in de composer draft store herkende alleen `"codex"`:

```typescript
// VOOR (broken):
function normalizeProviderKind(value: unknown): ProviderKind | null {
  return value === "codex" ? value : null;
}
```

**Gevolg:** Wanneer de gebruiker Claude Code selecteerde in de UI, werd `composerDraft.provider` genormaliseerd naar `null`. In `ChatView.tsx:801` valt dit terug naar `"codex"`:

```typescript
const selectedProvider: ProviderKind = lockedProvider ?? selectedProviderByThreadId ?? "codex";
```

Dus elke turn werd met `provider: 'codex'` naar de server gestuurd, ongeacht wat de UI toonde.

**Fix:**

```typescript
function normalizeProviderKind(value: unknown): ProviderKind | null {
  return value === "codex" || value === "claude-code" ? (value as ProviderKind) : null;
}
```

---

## Bug 2: Backend - `currentProvider` herkende alleen `"codex"` sessies

**Bestand:** `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:215-216`

**Probleem:** Bij het bepalen van de huidige provider van een thread-sessie werd alleen `"codex"` herkend:

```typescript
// VOOR (broken):
const currentProvider: ProviderKind | undefined =
  thread.session?.providerName === "codex" ? thread.session.providerName : undefined;
```

**Gevolg:** Voor Claude Code sessies was `currentProvider` altijd `undefined`, waardoor:

- `providerChanged` (regel 266) altijd `true` was -> sessie werd elke turn herstart
- `getCapabilities()` (regel 269) werd nooit aangeroepen voor claude-code
- `preferredProvider` (regel 217) negeerde de bestaande sessie-binding

**Fix:**

```typescript
const currentProvider: ProviderKind | undefined = thread.session?.providerName ?? undefined;
```

---

## Bug 3: Session Directory - `decodeProviderKind` verwierp `"claude-code"`

**Bestand:** `apps/server/src/provider/Layers/ProviderSessionDirectory.ts:24-37`

**Probleem:** De functie die provider names valideert bij het lezen uit de persistence laag herkende alleen `"codex"`:

```typescript
// VOOR (broken):
function decodeProviderKind(providerName: string, operation: string) {
  if (providerName === "codex") {
    return Effect.succeed(providerName);
  }
  return Effect.fail(
    new ProviderSessionDirectoryPersistenceError({
      operation,
      detail: `Unknown persisted provider '${providerName}'.`,
    }),
  );
}
```

**Gevolg:** Foutmelding `Unknown persisted provider 'claude-code'` wanneer een Claude Code sessie werd opgeslagen en later weer uitgelezen.

**Fix:**

```typescript
if (providerName === "codex" || providerName === "claude-code") {
  return Effect.succeed(providerName as ProviderKind);
}
```

---

## Bug 4: CLI Flag - `--verbose` ontbrak

**Bestand:** `apps/server/src/claudeCodeProcessManager.ts:325`

**Probleem:** De Claude CLI vereist `--verbose` wanneer je `--output-format stream-json` met `--print` combineert:

```typescript
// VOOR (broken):
const args: string[] = ["--print", "--output-format", "stream-json"];
```

**Gevolg:** Foutmelding `Error: When using --print, --output-format=stream-json requires --verbose`

**Fix:**

```typescript
const args: string[] = ["--print", "--output-format", "stream-json", "--verbose"];
```

---

## Bug 5: NDJSON Parser - `assistant` event type werd genegeerd

**Bestand:** `apps/server/src/claudeCodeProcessManager.ts:342-494` (`handleStreamEvent`)

**Probleem:** De parser verwachtte raw Anthropic API streaming events (`content_block_start`, `content_block_delta`, `content_block_stop`), maar de Claude CLI `--output-format stream-json` stuurt hogere-niveau events:

```jsonl
{"type":"system","subtype":"init","session_id":"..."}
{"type":"assistant","message":{"content":[{"type":"text","text":"Hallo!"}]},"session_id":"..."}
{"type":"result","subtype":"success","cost_usd":0.001,"session_id":"..."}
```

De `result` event werd afgehandeld (sessie ging naar ready), maar de `assistant` event met het daadwerkelijke antwoord werd compleet genegeerd door de switch statement.

**Gevolg:** Sessie draaide ~20 seconden, ging terug naar "ready" zonder error, maar er verscheen geen antwoord-bericht in de UI.

**Fix:** Nieuw `assistant` case toegevoegd aan de switch in `handleStreamEvent`:

```typescript
case "assistant": {
  const contentBlocks = event.message?.content;
  if (!contentBlocks || contentBlocks.length === 0) break;

  for (const block of contentBlocks) {
    if (block.type === "text" && block.text) {
      this.emitRuntimeEvent({
        ...base,
        type: "content.delta",
        payload: {
          streamKind: "assistant_text",
          delta: block.text,
          contentIndex: 0,
        },
      });
    } else if (block.type === "thinking" && block.thinking) {
      this.emitRuntimeEvent({
        ...base,
        type: "content.delta",
        payload: {
          streamKind: "reasoning_text",
          delta: block.thinking,
          contentIndex: 0,
        },
      });
    } else if (block.type === "tool_use" && block.name) {
      const itemId = makeRuntimeItemId();
      this.emitRuntimeEvent({
        ...base,
        itemId,
        type: "item.started",
        payload: { itemType: this.mapToolNameToItemType(block.name), status: "completed", title: block.name, data: { toolId: block.id, toolName: block.name, input: block.input } },
      });
      this.emitRuntimeEvent({
        ...base,
        itemId,
        type: "item.completed",
        payload: { itemType: this.mapToolNameToItemType(block.name), status: "completed", title: block.name },
      });
    }
  }
  break;
}
```

Ook de `ClaudeCodeStreamEvent` interface uitgebreid met `message` en `result` velden voor het hogere-niveau formaat.

---

## Architectuur: Event Flow

De volledige route van UI naar Claude CLI en terug:

```
UI (ChatView.tsx)
  ↓ provider: selectedProvider (was altijd "codex" door Bug 1)
  ↓ WebSocket: orchestration.dispatchCommand({ type: "thread.turn.start", provider: "claude-code" })

Server (wsServer.ts)
  ↓ command doorgegeven aan OrchestrationEngine

Decider (decider.ts:298)
  ↓ command.provider → event payload
  ↓ emits: "thread.turn-start-requested" { provider: "claude-code" }

ProviderCommandReactor (ProviderCommandReactor.ts)
  ↓ processTurnStartRequested()
  ↓ ensureSessionForThread() - bepaalt currentProvider (Bug 2), start/hergebruikt sessie
  ↓ sendTurnForThread() → providerService.sendTurn()

ProviderService (ProviderService.ts)
  ↓ resolveRoutableSession() → directory.getBinding() (Bug 3)
  ↓ registry.getByProvider("claude-code") → ClaudeCodeAdapter

ClaudeCodeAdapter (ClaudeCodeAdapter.ts)
  ↓ manager.sendTurn()

ClaudeCodeProcessManager (claudeCodeProcessManager.ts)
  ↓ spawn("claude", ["--print", "--output-format", "stream-json", "--verbose", ...]) (Bug 4)
  ↓ readline op stdout → handleStreamEvent() (Bug 5)
  ↓ emits: ProviderRuntimeEvents (turn.started, content.delta, turn.completed)

ProviderRuntimeIngestion (ProviderRuntimeIngestion.ts)
  ↓ content.delta → appendBufferedAssistantText → thread.message.assistant.delta
  ↓ turn.completed → finalizeAssistantMessage (flush buffer)

UI (ChatView.tsx)
  ↓ WebSocket push: orchestration.domainEvent
  ↓ Bericht verschijnt in chat
```

---

## Modelcatalogus

De beschikbare Claude modellen staan in `packages/contracts/src/model.ts`:

```typescript
MODEL_OPTIONS_BY_PROVIDER = {
  codex: [
    { slug: "gpt-5.4", name: "GPT-5.4" },
    { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    // ...
  ],
  "claude-code": [
    { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
};

DEFAULT_MODEL_BY_PROVIDER = {
  codex: "gpt-5.4",
  "claude-code": "claude-sonnet-4-6",
};

MODEL_SLUG_ALIASES_BY_PROVIDER = {
  "claude-code": {
    sonnet: "claude-sonnet-4-6",
    opus: "claude-opus-4-6",
    haiku: "claude-haiku-4-5",
  },
};
```

Om modellen toe te voegen/wijzigen: bewerk `packages/contracts/src/model.ts` en rebuild contracts (`bun run build` in packages/contracts).

---

## Provider Registratie

De `ClaudeCodeAdapter` wordt automatisch geregistreerd in `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts:30`:

```typescript
const adapters = options?.adapters ?? [yield * CodexAdapter, yield * ClaudeCodeAdapter];
```

De adapter wraps `ClaudeCodeProcessManager` en is gedefinieerd in:

- Service interface: `apps/server/src/provider/Services/ClaudeCodeAdapter.ts`
- Layer implementatie: `apps/server/src/provider/Layers/ClaudeCodeAdapter.ts`
- Process manager: `apps/server/src/claudeCodeProcessManager.ts`

---

## Bekende Beperkingen / TODO

1. **Geen streaming** - Het `assistant` event bevat het volledige antwoord in een keer (geen character-by-character streaming). De content_block_start/delta/stop handlers zijn nog aanwezig voor het geval `--verbose` deze raw events ook stuurt, maar in de praktijk komt het antwoord als een geheel via het `assistant` event.

2. **Geen tool result rendering** - Tool use blocks (`tool_use` type) worden gemeld als items maar de tool results van Claude worden nog niet getoond in de UI.

3. **Session resume** - Claude Code sessies gebruiken `--session-id` voor session continuity, maar resume na server restart is niet getest.

4. **`assistantDeliveryMode: 'buffered'`** - Het antwoord wordt gebufferd en pas bij `turn.completed` geflusht. Voor een betere UX zou je `enableAssistantStreaming` in de settings op `true` kunnen zetten, maar dan moet je wel character-by-character streaming hebben (punt 1).

5. **Custom Claude modellen** - Er is nog geen UI om custom Claude modellen toe te voegen (zoals er wel is voor Codex via `settings.customCodexModels`).

---

## Gewijzigde Bestanden (alleen Claude-gerelateerde fixes)

| Bestand                                                          | Bug    | Wijziging                                                  |
| ---------------------------------------------------------------- | ------ | ---------------------------------------------------------- |
| `apps/web/src/composerDraftStore.ts`                             | #1     | `normalizeProviderKind` accepteert nu `"claude-code"`      |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` | #2     | `currentProvider` leest `providerName` voor alle providers |
| `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`    | #3     | `decodeProviderKind` accepteert nu `"claude-code"`         |
| `apps/server/src/claudeCodeProcessManager.ts`                    | #4, #5 | `--verbose` flag + `assistant` event handler               |
