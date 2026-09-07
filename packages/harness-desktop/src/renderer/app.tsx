import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { HumanInputRequest, InteractionReview, PermissionRequest, SkillDescriptor } from "@harness/protocol"
import type { DesktopState, StartSessionInput, WorkspaceFileList, WorkspaceFilePreview } from "../shared/contracts"
import { copy } from "./copy"
import { Icon } from "./icons"

type ContextTab = "activity" | "files" | "usage" | "review" | "skills"

export function App() {
  const [state, setState] = createSignal<DesktopState>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [draft, setDraft] = createSignal("")
  const [modelId, setModelId] = createSignal("")
  const [checkingModels, setCheckingModels] = createSignal(false)
  const [acknowledgeOverage, setAcknowledgeOverage] = createSignal(false)
  const [allowFileChanges, setAllowFileChanges] = createSignal(false)
  const [acknowledgeBoundary, setAcknowledgeBoundary] = createSignal(false)
  const [contextOpen, setContextOpen] = createSignal(false)
  const [tab, setTab] = createSignal<ContextTab>("activity")
  const [reviews, setReviews] = createSignal<Record<string, InteractionReview>>({})
  const [selections, setSelections] = createSignal<Record<string, Record<string, string>>>({})
  const [now, setNow] = createSignal(Date.now())
  const [files, setFiles] = createSignal<WorkspaceFileList>()
  const [filePreview, setFilePreview] = createSignal<WorkspaceFilePreview>()
  const [fileMode, setFileMode] = createSignal<"text" | "diff">("diff")
  const [resumeOverage, setResumeOverage] = createSignal(false)
  const [resumeBoundary, setResumeBoundary] = createSignal(false)
  const [activations, setActivations] = createSignal<NonNullable<StartSessionInput["skills"]>>([])
  const configuration = () => state()?.configuration
  const runtime = () => configuration()?.runtime ?? "codex"
  const runtimeName = () => (runtime() === "claude" ? copy.claude : copy.codex)
  const executionAvailable = () => runtime() === "codex" || (runtime() === "claude" && ready())
  const runtimeText = (text: string) => text.replaceAll("Codex", runtimeName())
  const session = () => state()?.session
  const selectedConversation = () =>
    state()?.conversations?.items.find((item) => item.id === (state()?.history?.id ?? session()?.id))
  const viewingHistory = () => !!state()?.history && !session()
  const canRecover = () =>
    !busy() && !session() && executionAvailable() && ready() && !!selectedConversation()?.compatible
  const canInspect = () => canRecover() && (state()?.runtimeFeatures?.inspection ?? runtime() === "codex")
  const canResume = () =>
    canRecover() &&
    (state()?.runtimeFeatures?.resume ?? runtime() === "codex") &&
    ["idle", "interrupted", "closed", "failed"].includes(selectedConversation()?.status ?? "") &&
    resumeOverage() &&
    resumeBoundary()
  const running = () => ["running", "awaiting-permission", "awaiting-input"].includes(session()?.status ?? "")
  const canSend = () =>
    executionAvailable() &&
    !busy() &&
    !!session() &&
    ["idle", "interrupted"].includes(session()!.status) &&
    !!draft().trim()
  const pending = () => (state()?.permissions.length ?? 0) + (state()?.inputs.length ?? 0)
  const ready = () => state()?.connection.status === "ready"
  const modelsReady = () => state()?.models.status === "ready" && !!state()?.models.items.length
  const offeredModels = () => (modelsReady() ? state()!.models.items : [])
  const selectedModelAvailable = () => offeredModels().some((model) => model.id === modelId())
  const modelStatus = () =>
    checkingModels()
      ? runtimeText(copy.modelsLoading)
      : modelsReady()
        ? runtimeText(copy.modelHint)
        : state()?.models.status === "unavailable" || state()?.models.status === "ready"
          ? runtimeText(copy.modelsUnavailable)
          : state()?.models.status === "unsupported"
            ? copy.modelsUnsupported
            : runtimeText(copy.modelsNotLoaded)
  const canStart = () =>
    !busy() &&
    executionAvailable() &&
    !session() &&
    ready() &&
    !!configuration()?.workspace &&
    selectedModelAvailable() &&
    acknowledgeOverage() &&
    acknowledgeBoundary()
  const status = () =>
    session()
      ? (copy.sessionStatus[session()!.status] ?? session()!.status)
      : state()
        ? copy.connectionStatus[state()!.connection.status]
        : error()
          ? copy.unavailable
          : copy.loading
  const permissionIds = createMemo(() => state()?.permissions.map((request) => request.requestId) ?? [])
  const inputIds = createMemo(() => state()?.inputs.map((request) => request.requestId) ?? [])
  let contextHeading: HTMLHeadingElement | undefined
  let conversation: HTMLDivElement | undefined
  let followConversation = true

  function receive(next: DesktopState) {
    const current = state()
    if (current && next.revision < current.revision) return
    if (
      current?.configuration.workspace?.id !== next.configuration.workspace?.id ||
      current?.configuration.workspace?.path !== next.configuration.workspace?.path ||
      current?.configuration.executable !== next.configuration.executable ||
      current?.configuration.nativeHome !== next.configuration.nativeHome ||
      next.models.status !== "ready" ||
      !next.models.items.some((model) => model.id === modelId())
    ) {
      setModelId("")
    }
    if (viewIdentity(current) !== viewIdentity(next)) {
      setAcknowledgeOverage(false)
      setAllowFileChanges(false)
      setAcknowledgeBoundary(false)
      setResumeOverage(false)
      setResumeBoundary(false)
      setDraft("")
      setReviews({})
      setSelections({})
      setFiles(undefined)
      setFilePreview(undefined)
      setActivations([])
    }
    setActivations((previous) =>
      previous.filter((selected) =>
        next.skills?.skills.some(
          (skill) =>
            skill.id === selected.skillId &&
            skill.sha256 === selected.sha256 &&
            selectableSkill(skill, selected.invocation),
        ),
      ),
    )
    setState(next)
  }

  onMount(() => {
    if (!window.harness) {
      setError(copy.missingBridge)
      return
    }
    let receivedUpdate = false
    const dispose = window.harness.onState((next) => {
      receivedUpdate = true
      receive(next)
    })
    void window.harness
      .getState()
      .then((next) => {
        if (!receivedUpdate) receive(next)
      })
      .catch(() => setError(copy.failedRequest))
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => {
      dispose()
      window.clearInterval(timer)
      setReviews({})
      setSelections({})
    })
  })

  createEffect(() => {
    const valid = new Set([...permissionIds(), ...inputIds()])
    const timestamp = now()
    setReviews((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([id, review]) => valid.has(id) && Date.parse(review.expiresAt) > timestamp),
      ),
    )
    setSelections((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => valid.has(id))))
  })

  createEffect(() => {
    state()?.messages
    if (followConversation && conversation)
      requestAnimationFrame(() => conversation?.scrollTo({ top: conversation.scrollHeight }))
  })

  async function perform(operation: () => Promise<DesktopState>) {
    if (busy()) return
    setBusy(true)
    setError("")
    try {
      receive(await operation())
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failedRequest)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function selectRuntime(select: HTMLSelectElement) {
    const selected = select.value
    if (!busy() && !session() && (selected === "codex" || selected === "claude") && selected !== runtime()) {
      await perform(() => window.harness.selectRuntime({ runtime: selected }))
    }
    select.value = runtime()
  }

  async function refresh() {
    if (busy()) return
    setCheckingModels(executionAvailable() && !session())
    try {
      await perform(() => window.harness.refresh())
    } finally {
      setCheckingModels(false)
    }
  }

  function openContext(next?: ContextTab) {
    if (next) setTab(next)
    setContextOpen(true)
    queueMicrotask(() => {
      if (next) document.getElementById(`panel-${next}`)?.focus()
      if (!next) contextHeading?.focus()
    })
  }

  async function send() {
    if (!canSend()) return
    const text = draft().trim()
    if (await perform(() => window.harness.send({ text }))) {
      setDraft("")
      followConversation = true
    }
  }

  async function openReview(kind: "permission" | "input", requestId: string) {
    if (busy()) return
    setBusy(true)
    setError("")
    const identity = viewIdentity(state())
    try {
      const review = await window.harness.review({ kind, requestId })
      const current = kind === "permission" ? permissionIds() : inputIds()
      if (
        identity === viewIdentity(state()) &&
        current.includes(requestId) &&
        Date.parse(review.expiresAt) > Date.now()
      ) {
        setReviews((previous) => ({ ...previous, [requestId]: review }))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failedRequest)
    } finally {
      setBusy(false)
    }
  }

  async function readFiles<T>(operation: () => Promise<T>, accept: (result: T) => void) {
    if (busy()) return
    const identity = viewIdentity(state())
    setBusy(true)
    setError("")
    try {
      const result = await operation()
      if (identity === viewIdentity(state())) accept(result)
    } catch (cause) {
      if (identity === viewIdentity(state())) setError(cause instanceof Error ? cause.message : copy.failedRequest)
    } finally {
      setBusy(false)
    }
  }

  function toggleSkill(skill: SkillDescriptor, invocation: "user" | "model", checked: boolean) {
    if (busy() || session() || runtime() !== "claude" || !ready() || !selectableSkill(skill, invocation)) return
    const remaining = activations().filter(
      (selected) => selected.skillId !== skill.id || selected.invocation !== invocation,
    )
    if (checked && remaining.length >= 16) return
    setActivations(checked ? [...remaining, { skillId: skill.id, sha256: skill.sha256, invocation }] : remaining)
  }

  function clearReview(requestId: string) {
    setReviews((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== requestId)))
    setSelections((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== requestId)))
  }

  async function resolvePermission(request: PermissionRequest, choiceId: string) {
    const reviewToken = reviews()[request.requestId]?.reviewToken
    await perform(() =>
      window.harness.resolvePermission({
        requestId: request.requestId,
        choiceId,
        ...(reviewToken ? { reviewToken } : {}),
      }),
    )
    clearReview(request.requestId)
  }

  async function resolveInput(request: HumanInputRequest, action: "answer" | "cancel") {
    const reviewToken = reviews()[request.requestId]?.reviewToken
    const chosen =
      action === "answer"
        ? request.questions.map((question) => ({
            questionId: question.id,
            optionId: selections()[request.requestId]?.[question.id] ?? "",
          }))
        : []
    await perform(() =>
      window.harness.resolveInput({
        requestId: request.requestId,
        action,
        selections: chosen,
        ...(reviewToken ? { reviewToken } : {}),
      }),
    )
    clearReview(request.requestId)
  }

  function tabKey(event: KeyboardEvent) {
    const tabs: ContextTab[] = ["activity", "files", "usage", "review", "skills"]
    const index = tabs.indexOf(tab())
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index + tabs.length - 1) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : -1
    if (next < 0) return
    event.preventDefault()
    setTab(tabs[next]!)
    document.getElementById(`tab-${tabs[next]}`)?.focus()
  }

  return (
    <div class="app-shell">
      <a class="skip-link" href="#message-composer">
        {copy.skipToMessage}
      </a>
      <aside class="sidebar" aria-label={copy.repository}>
        <div class="brand">
          <span class="brand-symbol" aria-hidden="true" />
          <span class="brand-name">{copy.appName}</span>
        </div>
        <section class="sidebar-section">
          <h2 class="sidebar-heading">{copy.repository}</h2>
          <button
            class="workspace-picker"
            disabled={busy() || !!session() || !state()}
            onClick={() => void perform(() => window.harness.chooseWorkspace())}
            title={configuration()?.workspace?.path ?? copy.chooseRepository}
          >
            <Icon name="folder" />
            <span>{configuration()?.workspace?.name ?? copy.chooseRepository}</span>
            <Icon name="chevron" />
          </button>
          <Show when={!configuration()?.workspace}>
            <p class="sidebar-description">{copy.repositoryHint}</p>
          </Show>
        </section>
        <section class="sidebar-section sidebar-sessions">
          <h2 class="sidebar-heading">{copy.sessions}</h2>
          <Show
            when={state()?.conversations?.items.length}
            fallback={
              <Show when={session()} fallback={<p class="sidebar-description">{copy.noSessions}</p>}>
                {(current) => (
                  <div class="session-list">
                    <button class="session-item" data-selected="true" aria-current="page" title={current().id}>
                      <span class="status-dot" data-active={running()} />
                      <span class="session-name">{configuration()?.workspace?.name ?? copy.conversation}</span>
                      <span class="session-detail">{status()}</span>
                    </button>
                  </div>
                )}
              </Show>
            }
          >
            <div class="session-list">
              <For each={state()?.conversations?.items}>
                {(item) => (
                  <button
                    class="session-item"
                    data-selected={item.id === (state()?.history?.id ?? session()?.id)}
                    aria-current={item.id === (state()?.history?.id ?? session()?.id) ? "page" : undefined}
                    disabled={busy() || !!session()}
                    title={item.id}
                    onClick={() => void perform(() => window.harness.viewConversation({ sessionId: item.id }))}
                  >
                    <span class="status-dot" data-active={item.id === session()?.id && running()} />
                    <span class="session-name">{item.modelId}</span>
                    <span class="session-detail">{copy.sessionStatus[item.status] ?? item.status}</span>
                    <time class="session-detail" dateTime={item.updatedAt}>
                      {new Date(item.updatedAt).toLocaleString()}
                    </time>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={state()?.conversations?.truncated}>
            <p class="sidebar-description">{copy.conversationsLimited}</p>
          </Show>
          <button
            class="new-session"
            disabled={!!session() || busy() || !state()}
            title={session() ? copy.singleSession : copy.newConversation}
            onClick={() => {
              if (state()?.history) void perform(() => window.harness.detachConversation()).then(() => openContext())
              if (!state()?.history) openContext()
            }}
          >
            <Icon name="plus" size={15} />
            {copy.newConversation}
          </button>
        </section>
        <div class="sidebar-spacer" />
        <section class="sidebar-section sidebar-runtime">
          <label class="sidebar-heading" for="runtime-choice">
            {copy.runtime}
          </label>
          <select
            class="runtime-select"
            id="runtime-choice"
            value={runtime()}
            aria-label={copy.runtimeSelect}
            disabled={busy() || !!session() || !state()}
            onChange={(event) => void selectRuntime(event.currentTarget)}
          >
            <option value="codex">{copy.codex}</option>
            <option value="claude">{copy.claude}</option>
            <option disabled>{copy.openCodePending}</option>
          </select>
          <p class="sidebar-description">{executionAvailable() ? copy.nativeSubscription : copy.connectionChecks}</p>
        </section>
        <footer class="sidebar-footer">
          <Icon name="shield" size={14} />
          {copy.localWorkspace}
        </footer>
      </aside>

      <main class="workbench">
        <header class="workbench-header">
          <div>
            <h1 class="workbench-title">{configuration()?.workspace?.name ?? copy.conversation}</h1>
            <p class="workbench-subtitle">
              <span class="status-dot" data-active={running()} />
              {status()}
            </p>
          </div>
          <div class="header-actions">
            <Show when={session()}>
              <button
                class="secondary-button"
                disabled={busy()}
                onClick={() => void perform(() => window.harness.detachConversation())}
              >
                {copy.closeConversation}
              </button>
            </Show>
            <Show when={pending() > 0}>
              <button class="secondary-button" onClick={() => openContext("review")}>
                {copy.review}
                <span class="tab-count">{pending()}</span>
              </button>
            </Show>
            <button
              class="icon-button"
              title={copy.refresh}
              aria-label={copy.refresh}
              disabled={busy() || !state()}
              onClick={() => void refresh()}
            >
              <Icon name="refresh" size={16} />
            </button>
            <button
              class="icon-button context-toggle"
              title={copy.openContext}
              aria-label={copy.openContext}
              aria-expanded={contextOpen()}
              aria-controls="context-panel"
              onClick={() => openContext()}
            >
              <Icon name="activity" />
            </button>
          </div>
        </header>
        <Show when={error()}>
          <div class="error-banner" role="alert">
            <span>{error()}</span>
            <button class="icon-button" onClick={() => setError("")} aria-label={copy.dismissError}>
              <Icon name="close" size={15} />
            </button>
          </div>
        </Show>
        <For each={state()?.notices}>
          {(notice) => (
            <p class="conversation-notice" role="status">
              {notice}
            </p>
          )}
        </For>
        <Show when={viewingHistory()}>
          <section class="history-panel" aria-label={copy.savedConversation}>
            <div class="section-heading">
              <h2>{copy.savedConversation}</h2>
              <span>{selectedConversation()?.modelId}</span>
            </div>
            <p>{copy.historyPartial}</p>
            <Show when={(state()?.history?.unconfirmedMessages ?? 0) > 0}>
              <p class="attention">{copy.historyUnconfirmed}</p>
            </Show>
            <Show when={!selectedConversation()?.compatible}>
              <p class="attention">{copy.historyIncompatible}</p>
            </Show>
            <Show when={selectedConversation()?.compatible && !ready()}>
              <p class="attention">{copy.historyCheckConnection}</p>
            </Show>
            <div class="history-actions">
              <button
                class="secondary-button"
                disabled={!canInspect()}
                onClick={() =>
                  void perform(() => window.harness.inspectConversation({ sessionId: state()!.history!.id }))
                }
              >
                {copy.inspectConversation}
              </button>
              <button
                class="secondary-button"
                disabled={
                  !canInspect() ||
                  selectedConversation()?.status !== "uncertain" ||
                  state()?.inspection?.sessionId !== state()?.history?.id
                }
                onClick={() =>
                  void perform(() => window.harness.reconcileConversation({ sessionId: state()!.history!.id }))
                }
              >
                {copy.reconcileConversation}
              </button>
            </div>
            <Show when={state()?.inspection?.sessionId === state()?.history?.id && state()?.inspection}>
              {(inspection) => (
                <div class="inspection-summary" role="status">
                  <p>
                    {copy.inspectionState}: {inspection().nativeState}. {copy.inspectionCoverage}:{" "}
                    {inspection().completeness}.
                  </p>
                  <p>
                    {inspection().terminalTurns} {copy.terminalTurns}, {inspection().runningTurns} {copy.runningTurns},{" "}
                    {inspection().unknownTurns} {copy.unknownTurns}.
                  </p>
                  <time dateTime={inspection().observedAt}>{new Date(inspection().observedAt).toLocaleString()}</time>
                </div>
              )}
            </Show>
            <p class="model-hint">{copy.resumeHint}</p>
            <Show when={ready() && state()?.runtimeFeatures?.inspection === false}>
              <p class="model-hint">{copy.inspectionUnavailable}</p>
            </Show>
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={resumeOverage()}
                onChange={(event) => setResumeOverage(event.currentTarget.checked)}
              />
              <span>{copy.acknowledgeOverage}</span>
            </label>
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={resumeBoundary()}
                onChange={(event) => setResumeBoundary(event.currentTarget.checked)}
              />
              <span>{copy.acknowledgeBoundary}</span>
            </label>
            <button
              class="primary-button"
              disabled={!canResume()}
              onClick={() => {
                if (!canResume()) return
                void perform(() =>
                  window.harness.resumeConversation({
                    sessionId: state()!.history!.id,
                    acknowledgeOverage: resumeOverage(),
                    acknowledgeUnverifiedBoundary: resumeBoundary(),
                  }),
                )
              }}
            >
              {copy.resumeConversation}
            </button>
          </section>
        </Show>
        <div
          class="conversation"
          ref={conversation}
          onScroll={() => {
            if (conversation)
              followConversation = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 80
          }}
        >
          <Show
            when={(state()?.messages.length ?? 0) > 0}
            fallback={
              <div class="empty-conversation">
                <span class="empty-mark">
                  <Icon name="code" size={27} />
                </span>
                <h2>
                  {!executionAvailable()
                    ? copy.claudeEmptyTitle
                    : session()
                      ? copy.emptySessionTitle
                      : configuration()?.workspace
                        ? copy.emptyConfiguredTitle
                        : copy.emptyTitle}
                </h2>
                <p>
                  {!executionAvailable()
                    ? copy.claudeEmptyDescription
                    : session()
                      ? copy.emptySessionDescription
                      : configuration()?.workspace
                        ? copy.emptyConfiguredDescription
                        : copy.emptyDescription}
                </p>
                <Show when={!session()}>
                  <button
                    class="primary-button"
                    disabled={busy() || !state()}
                    onClick={() =>
                      configuration()?.workspace ? openContext() : void perform(() => window.harness.chooseWorkspace())
                    }
                  >
                    <Icon name={configuration()?.workspace ? "code" : "folder"} size={16} />
                    {configuration()?.workspace ? copy.openSetup : copy.chooseRepository}
                  </button>
                </Show>
                <div class="empty-footnote">{copy.emptyFootnote}</div>
              </div>
            }
          >
            <ol class="message-list" aria-label={copy.conversation}>
              <For each={state()?.messages}>
                {(message) => (
                  <li class="message" data-role={message.role}>
                    <div class="message-header">
                      <span class="message-avatar" aria-hidden="true">
                        {message.role === "user" ? copy.userInitial : <Icon name="code" size={14} />}
                      </span>
                      {message.role === "user" ? copy.you : runtimeName()}
                    </div>
                    <div class="message-body">{message.text}</div>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </div>
        <section class="composer-region" aria-label={copy.promptLabel[runtime()]}>
          <form
            class="composer"
            onSubmit={(event) => {
              event.preventDefault()
              void send()
            }}
          >
            <label class="sr-only" for="message-composer">
              {copy.promptLabel[runtime()]}
            </label>
            <textarea
              id="message-composer"
              value={draft()}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.isComposing) {
                  event.preventDefault()
                  void send()
                }
              }}
              placeholder={
                !executionAvailable()
                  ? copy.connectionChecks
                  : session()
                    ? copy.promptPlaceholder
                    : copy.promptUnavailable
              }
              disabled={!session() || !executionAvailable()}
              maxLength={100000}
            />
            <div class="composer-actions">
              <span class="composer-hint">
                {!executionAvailable()
                  ? copy.connectionChecks
                  : running()
                    ? pending()
                      ? copy.awaiting
                      : copy.running[runtime()]
                    : copy.composerHint}
              </span>
              <div class="composer-buttons">
                <Show when={running()}>
                  <button
                    type="button"
                    class="secondary-button"
                    disabled={busy()}
                    onClick={() => void perform(() => window.harness.interrupt())}
                  >
                    <Icon name="stop" size={13} />
                    {copy.interrupt}
                  </button>
                </Show>
                <button
                  class="primary-button send-button"
                  type="submit"
                  disabled={!canSend()}
                  title={copy.send}
                  aria-label={copy.send}
                >
                  <Icon name="send" size={17} />
                </button>
              </div>
            </div>
          </form>
          <div class="composer-note">
            <span>{executionAvailable() ? copy.composerNote : copy.claudeUnavailable}</span>
            <Show when={executionAvailable()}>
              <span>{allowFileChanges() ? copy.workspaceWrite : copy.workspaceReadOnly}</span>
            </Show>
          </div>
        </section>
      </main>

      <aside
        class="context-panel"
        id="context-panel"
        data-open={contextOpen()}
        aria-label={copy.context}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setContextOpen(false)
            document.querySelector<HTMLButtonElement>(".context-toggle")?.focus()
          }
        }}
      >
        <header class="context-header">
          <h2 ref={contextHeading} tabIndex={-1}>
            {copy.context}
          </h2>
          <button
            class="icon-button context-close"
            aria-label={copy.closeContext}
            onClick={() => setContextOpen(false)}
          >
            <Icon name="close" size={16} />
          </button>
        </header>
        <div class="context-scroll">
          <section class="account-section" aria-label={copy.setup}>
            <div class="section-heading">
              <h2>{copy.setup}</h2>
              <span class="status-label" data-ready={ready()}>
                {state()
                  ? copy.connectionStatus[state()!.connection.status]
                  : error()
                    ? copy.unavailable
                    : copy.loading}
              </span>
            </div>
            <div class="runtime-wordmark">
              <span class="runtime-logo">
                <Icon name="code" size={18} />
              </span>
              {runtimeName()}
            </div>
            <dl class="metadata">
              <dt>{copy.authentication}</dt>
              <dd>{copy.authenticationStatus[state()?.connection.authentication ?? "unknown"]}</dd>
              <dt>{copy.billing}</dt>
              <dd>{state()?.connection.billing === "subscription" ? copy.subscription : copy.unknown}</dd>
              <dt>{copy.overage}</dt>
              <dd>{copy.unknown}</dd>
              <Show when={state()?.connection.runtimeVersion}>
                <dt>{copy.version}</dt>
                <dd>{state()?.connection.runtimeVersion}</dd>
              </Show>
            </dl>
            <Show when={state()?.connection.reason}>
              <p class="attention">{state()?.connection.reason}</p>
            </Show>
            <Show when={!session()}>
              <div class="setup-actions">
                <button
                  class="secondary-button"
                  disabled={busy() || !state()}
                  onClick={() => void perform(() => window.harness.chooseRuntime())}
                >
                  <Icon name="code" size={14} />
                  {copy.chooseExecutable[runtime()]}
                </button>
                <Show when={configuration()?.executable}>
                  <span class="setup-path" title={configuration()?.executable}>
                    {copy.selectedExecutable}: {configuration()?.executable}
                  </span>
                </Show>
                <button
                  class="secondary-button"
                  disabled={busy() || !state()}
                  onClick={() => void perform(() => window.harness.chooseNativeHome())}
                >
                  <Icon name="folder" size={14} />
                  {copy.chooseNativeHome}
                </button>
                <Show when={configuration()?.nativeHome}>
                  <span class="setup-path" title={configuration()?.nativeHome}>
                    {copy.selectedNativeHome}: {configuration()?.nativeHome}
                  </span>
                </Show>
                <p class="model-hint">{copy.setupHint[runtime()]}</p>
                <button
                  class="secondary-button"
                  disabled={busy() || !configuration()?.executable || !configuration()?.nativeHome}
                  onClick={() => void refresh()}
                >
                  <Icon name="refresh" size={14} />
                  {copy.checkConnection}
                </button>
              </div>
              <Show when={!executionAvailable()}>
                <p class="attention">{copy.claudeUnavailable}</p>
              </Show>
              <Show when={executionAvailable() && !viewingHistory()}>
                <label class="model-label" for="model-id">
                  {runtimeText(copy.modelLabel)}
                </label>
                <select
                  id="model-id"
                  class="model-select"
                  value={modelId()}
                  disabled={busy() || !modelsReady()}
                  aria-describedby="model-status"
                  onChange={(event) => {
                    const selected = event.currentTarget.value
                    setModelId(offeredModels().some((model) => model.id === selected) ? selected : "")
                  }}
                >
                  <option value="">{checkingModels() ? runtimeText(copy.modelsLoading) : copy.modelPlaceholder}</option>
                  <For each={offeredModels()}>
                    {(model) => (
                      <option value={model.id}>
                        {model.name === model.id ? model.id : `${model.name} (${model.id})`}
                      </option>
                    )}
                  </For>
                </select>
                <p class="model-hint" id="model-status" role="status" aria-live="polite">
                  {modelStatus()}
                </p>
                <p class="attention">{runtimeText(copy.overageNotice)}</p>
                <label class="checkbox-label">
                  <input
                    type="checkbox"
                    checked={acknowledgeOverage()}
                    onChange={(event) => setAcknowledgeOverage(event.currentTarget.checked)}
                  />
                  <span>{copy.acknowledgeOverage}</span>
                </label>
                <label class="checkbox-label">
                  <input
                    type="checkbox"
                    checked={allowFileChanges()}
                    onChange={(event) => setAllowFileChanges(event.currentTarget.checked)}
                  />
                  <span>{copy.allowFileChanges}</span>
                </label>
                <label class="checkbox-label">
                  <input
                    type="checkbox"
                    checked={acknowledgeBoundary()}
                    onChange={(event) => setAcknowledgeBoundary(event.currentTarget.checked)}
                  />
                  <span>{copy.acknowledgeBoundary}</span>
                </label>
              </Show>
              <Show when={!viewingHistory()}>
                <button
                  class="primary-button full-width"
                  disabled={!canStart()}
                  onClick={() => {
                    if (!canStart()) return
                    void perform(() =>
                      window.harness.start({
                        modelId: modelId(),
                        acknowledgeOverage: acknowledgeOverage(),
                        allowFileChanges: allowFileChanges(),
                        acknowledgeUnverifiedBoundary: acknowledgeBoundary(),
                        ...(runtime() === "claude" && activations().length ? { skills: activations() } : {}),
                      }),
                    )
                  }}
                >
                  {copy.startConversation}
                </button>
              </Show>
            </Show>
            <Show when={session()}>
              <p class="model-hint">
                {copy.sessionStarted}: {session()?.modelId}
              </p>
            </Show>
          </section>
          <div class="context-tabs" role="tablist" aria-label={copy.contextTabs} onKeyDown={tabKey}>
            <For each={["activity", "files", "usage", "review", "skills"] as const}>
              {(item) => (
                <button
                  class="context-tab"
                  id={`tab-${item}`}
                  role="tab"
                  aria-selected={tab() === item}
                  aria-controls={`panel-${item}`}
                  tabIndex={tab() === item ? 0 : -1}
                  onClick={() => setTab(item)}
                >
                  <Icon
                    name={
                      item === "activity" || item === "usage"
                        ? "activity"
                        : item === "files"
                          ? "folder"
                          : item === "skills"
                            ? "book"
                            : "shield"
                    }
                    size={13}
                  />
                  {copy[item]}
                  <Show when={item === "review" && pending() > 0}>
                    <span class="tab-count">{pending()}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
          <Show when={tab() === "activity"}>
            <section class="panel-body" id="panel-activity" role="tabpanel" aria-labelledby="tab-activity" tabIndex={0}>
              <Show
                when={(state()?.activity.length ?? 0) > 0}
                fallback={
                  <div class="panel-empty">
                    <Icon name="activity" size={24} />
                    <strong>{copy.activityEmptyTitle}</strong>
                    <p>{copy.activityEmpty}</p>
                  </div>
                }
              >
                <ol class="activity-list">
                  <For each={state()?.activity}>
                    {(item) => (
                      <li class="activity-item">
                        <p class="activity-label">{item.label}</p>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>
            </section>
          </Show>
          <Show when={tab() === "files"}>
            <section class="panel-body" id="panel-files" role="tabpanel" aria-labelledby="tab-files" tabIndex={0}>
              <p class="model-hint">{copy.filesHint}</p>
              <button
                class="secondary-button full-width"
                disabled={busy() || !configuration()?.workspace}
                onClick={() => {
                  setFilePreview(undefined)
                  void readFiles(() => window.harness.listFiles(), setFiles)
                }}
              >
                {copy.refreshFiles}
              </button>
              <Show when={files()} fallback={<p class="panel-empty">{copy.filesNotLoaded}</p>}>
                {(catalog) => (
                  <>
                    <p class="model-hint">
                      {catalog().baseline === "session-start" ? copy.fileBaseline : copy.fileBaselineUnavailable}
                    </p>
                    <Show when={catalog().truncated}>
                      <p class="attention" role="status">
                        {copy.filesLimited}
                      </p>
                    </Show>
                    <Show when={!catalog().items.length}>
                      <p class="panel-empty">{copy.filesEmpty}</p>
                    </Show>
                    <ul class="file-list">
                      <For each={catalog().items}>
                        {(file) => (
                          <li>
                            <button
                              class="file-item"
                              disabled={busy()}
                              onClick={() =>
                                void readFiles(() => window.harness.previewFile({ fileId: file.id }), setFilePreview)
                              }
                            >
                              <span class="file-path">{file.path}</span>
                              <span class="file-change">{copy.fileChange[file.change]}</span>
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </>
                )}
              </Show>
              <Show when={filePreview()}>
                {(preview) => (
                  <article class="file-preview" aria-label={copy.filePreview}>
                    <h3>{preview().path}</h3>
                    <div class="file-view-controls">
                      <button
                        class="secondary-button"
                        aria-pressed={fileMode() === "diff"}
                        onClick={() => setFileMode("diff")}
                      >
                        {copy.fileDiff}
                      </button>
                      <button
                        class="secondary-button"
                        aria-pressed={fileMode() === "text"}
                        onClick={() => setFileMode("text")}
                      >
                        {copy.fileText}
                      </button>
                    </div>
                    <Show
                      when={fileMode() === "diff"}
                      fallback={
                        <Show
                          when={preview().text !== null}
                          fallback={<p class="model-hint">{copy.fileTextUnavailable}</p>}
                        >
                          <pre class="file-content">{preview().text}</pre>
                        </Show>
                      }
                    >
                      <Show
                        when={preview().diff !== null}
                        fallback={<p class="model-hint">{copy.fileBaselineUnavailable}</p>}
                      >
                        <pre class="file-content">{preview().diff || copy.fileUnchanged}</pre>
                      </Show>
                    </Show>
                  </article>
                )}
              </Show>
            </section>
          </Show>
          <Show when={tab() === "usage"}>
            <section class="panel-body" id="panel-usage" role="tabpanel" aria-labelledby="tab-usage" tabIndex={0}>
              <h3>{copy.tokenUsage}</h3>
              <p class="model-hint">
                {state()?.usage?.basis === "cumulative"
                  ? copy.usageCumulative
                  : state()?.usage
                    ? copy.usageLatest
                    : copy.usageUnavailable}
              </p>
              <dl class="metadata usage-metadata">
                <dt>{copy.inputTokens}</dt>
                <dd>{count(state()?.usage?.tokens?.input)}</dd>
                <dt>{copy.outputTokens}</dt>
                <dd>{count(state()?.usage?.tokens?.output)}</dd>
                <dt>{copy.cachedTokens}</dt>
                <dd>{count(state()?.usage?.tokens?.cacheRead)}</dd>
                <dt>{copy.reasoningTokens}</dt>
                <dd>{count(state()?.usage?.tokens?.reasoning)}</dd>
              </dl>
              <p class="model-hint">{copy.usageRelations}</p>
              <h3>{copy.contextUsage}</h3>
              <dl class="metadata usage-metadata">
                <dt>{copy.contextUsed}</dt>
                <dd>
                  {state()?.context?.basis === "native-context" ? count(state()?.context?.usedTokens) : copy.unknown}
                </dd>
                <dt>{copy.contextCapacity}</dt>
                <dd>
                  {state()?.context?.basis === "native-context"
                    ? count(state()?.context?.capacityTokens)
                    : copy.unknown}
                </dd>
              </dl>
              <p class="model-hint">{copy.usageLimit}</p>
            </section>
          </Show>
          <Show when={tab() === "review"}>
            <section class="panel-body" id="panel-review" role="tabpanel" aria-labelledby="tab-review" tabIndex={0}>
              <Show when={pending() === 0}>
                <div class="panel-empty">
                  <Icon name="shield" size={24} />
                  <strong>{copy.reviewEmptyTitle}</strong>
                  <p>{copy.reviewEmpty}</p>
                </div>
              </Show>
              <For each={permissionIds()}>
                {(id) => {
                  const request = () => state()?.permissions.find((item) => item.requestId === id)
                  const review = () => reviews()[id]
                  const patch = () => {
                    const content = review()?.content
                    return content?.kind === "patch" ? content : undefined
                  }
                  return (
                    <Show when={request()}>
                      {(current) => (
                        <article class="review-request">
                          <h3>{current().action === "file-change" ? copy.fileReview : copy.permissionReview}</h3>
                          <For each={current().resources}>{(resource) => <p class="review-path">{resource}</p>}</For>
                          <p class="review-expiry">
                            {copy.expires} {new Date(current().expiresAt).toLocaleTimeString()}
                          </p>
                          <Show
                            when={current().reviewArtifact}
                            fallback={<p class="permission-summary">{copy.reviewUnavailable}</p>}
                          >
                            <button
                              class="secondary-button full-width"
                              disabled={busy()}
                              onClick={() => void openReview("permission", id)}
                            >
                              <Icon name="shield" size={14} />
                              {review() ? copy.reviewed : copy.openReview}
                            </button>
                          </Show>
                          <Show when={patch()}>
                            {(content) => (
                              <For each={content().changes}>
                                {(change) => (
                                  <details class="diff-change" open>
                                    <summary>
                                      {copy.change[change.kind]}: {change.path}
                                    </summary>
                                    <Show when={change.movePath}>
                                      <p class="review-path">
                                        {copy.movedTo}: {change.movePath}
                                      </p>
                                    </Show>
                                    <pre class="review-diff" tabIndex={0}>
                                      {change.diff}
                                    </pre>
                                  </details>
                                )}
                              </For>
                            )}
                          </Show>
                          <div class="review-actions">
                            <For each={current().choices}>
                              {(choice) => (
                                <button
                                  class={choice.action === "allow" ? "primary-button" : "secondary-button"}
                                  disabled={
                                    busy() ||
                                    Date.parse(current().expiresAt) <= now() ||
                                    (choice.action === "allow" && !patch())
                                  }
                                  onClick={() => void resolvePermission(current(), choice.id)}
                                >
                                  {choice.label}
                                </button>
                              )}
                            </For>
                          </div>
                        </article>
                      )}
                    </Show>
                  )
                }}
              </For>
              <For each={inputIds()}>
                {(id) => {
                  const request = () => state()?.inputs.find((item) => item.requestId === id)
                  const review = () => reviews()[id]
                  const questions = () => {
                    const content = review()?.content
                    return content?.kind === "choice-input" ? content : undefined
                  }
                  const complete = () =>
                    request()?.questions.every((question) =>
                      question.optionIds.includes(selections()[id]?.[question.id] ?? ""),
                    )
                  return (
                    <Show when={request()}>
                      {(current) => (
                        <article class="review-request">
                          <h3>{copy.questionReview}</h3>
                          <p class="review-expiry">
                            {copy.expires} {new Date(current().expiresAt).toLocaleTimeString()}
                          </p>
                          <Show
                            when={current().reviewArtifact}
                            fallback={<p class="permission-summary">{copy.questionUnavailable}</p>}
                          >
                            <button
                              class="secondary-button full-width"
                              disabled={busy()}
                              onClick={() => void openReview("input", id)}
                            >
                              <Icon name="shield" size={14} />
                              {review() ? copy.reviewed : copy.openReview}
                            </button>
                          </Show>
                          <Show when={questions()}>
                            {(content) => (
                              <For each={content().questions}>
                                {(question) => (
                                  <fieldset class="question">
                                    <legend>{question.header}</legend>
                                    <p class="question-description">{question.question}</p>
                                    <For each={question.options}>
                                      {(option) => (
                                        <label class="question-choice">
                                          <input
                                            type="radio"
                                            name={`${id}:${question.id}`}
                                            value={option.id}
                                            checked={selections()[id]?.[question.id] === option.id}
                                            onChange={() =>
                                              setSelections((previous) => ({
                                                ...previous,
                                                [id]: { ...previous[id], [question.id]: option.id },
                                              }))
                                            }
                                          />
                                          <span>
                                            <strong>{option.label}</strong>
                                            <small>{option.description}</small>
                                          </span>
                                        </label>
                                      )}
                                    </For>
                                  </fieldset>
                                )}
                              </For>
                            )}
                          </Show>
                          <div class="review-actions">
                            <button
                              class="primary-button"
                              disabled={
                                busy() || !questions() || !complete() || Date.parse(current().expiresAt) <= now()
                              }
                              onClick={() => void resolveInput(current(), "answer")}
                            >
                              {copy.submitAnswers}
                            </button>
                            <button
                              class="secondary-button"
                              disabled={busy()}
                              onClick={() => void resolveInput(current(), "cancel")}
                            >
                              {copy.cancelQuestion}
                            </button>
                          </div>
                        </article>
                      )}
                    </Show>
                  )
                }}
              </For>
            </section>
          </Show>
          <Show when={tab() === "skills"}>
            <section class="panel-body" id="panel-skills" role="tabpanel" aria-labelledby="tab-skills" tabIndex={0}>
              <p class="skill-intro">{copy.skillsIntro}</p>
              <p class="attention">{runtime() === "claude" && ready() ? copy.skillsSelection : copy.skillsPending}</p>
              <Show when={runtime() === "claude" && ready() && !session()}>
                <p class="model-hint">
                  {activations().length}/16 {copy.skillsSelected}
                </p>
              </Show>
              <button
                class="secondary-button full-width"
                disabled={busy() || !state() || !!session()}
                onClick={() => void perform(() => window.harness.chooseSkillsRoot())}
              >
                <Icon name="folder" size={14} />
                {copy.chooseSkillsRoot}
              </button>
              <Show when={!configuration()?.workspace}>
                <p class="panel-empty">{copy.skillsWorkspaceMissing}</p>
              </Show>
              <Show when={configuration()?.workspace && !state()?.skills?.skills.length}>
                <div class="panel-empty">
                  <Icon name="book" size={24} />
                  <strong>{copy.skillsEmptyTitle}</strong>
                  <p>{copy.skillsEmpty}</p>
                </div>
              </Show>
              <Show when={(state()?.skills?.diagnostics.length ?? 0) > 0}>
                <p class="skill-diagnostics">{copy.skillDiagnostics}</p>
              </Show>
              <For each={state()?.skills?.skills}>
                {(skill) => (
                  <article class="skill-item">
                    <h3>/{skill.commandName}</h3>
                    <p>{skill.description ?? copy.skillNoDescription}</p>
                    <p class="review-path">{skill.relativePath}</p>
                    <span class="skill-source">
                      {skill.scope === "workspace" ? copy.skillWorkspace : copy.skillUser}
                    </span>
                    <Show when={skill.observedFeatures.length > 0}>
                      <p>
                        {copy.skillFeatures}: {skill.observedFeatures.join(", ")}
                      </p>
                    </Show>
                    <Show
                      when={runtime() === "claude" && ready() && !session()}
                      fallback={<p>{session() && runtime() === "claude" ? copy.skillsFixed : copy.skillDisabled}</p>}
                    >
                      <For each={["user", "model"] as const}>
                        {(invocation) => {
                          const selected = () =>
                            activations().some((value) => value.skillId === skill.id && value.invocation === invocation)
                          return (
                            <label class="checkbox-label skill-choice">
                              <input
                                type="checkbox"
                                checked={selected()}
                                disabled={
                                  busy() ||
                                  !selectableSkill(skill, invocation) ||
                                  (!selected() && activations().length >= 16)
                                }
                                onChange={(event) => toggleSkill(skill, invocation, event.currentTarget.checked)}
                              />
                              <span>
                                {invocation === "user" ? copy.skillUserInvocation : copy.skillModelInvocation} /
                                {skill.commandName}
                              </span>
                            </label>
                          )
                        }}
                      </For>
                      <Show when={!selectableSkill(skill, "user") && !selectableSkill(skill, "model")}>
                        <p>{copy.skillUnsupported}</p>
                      </Show>
                    </Show>
                  </article>
                )}
              </For>
            </section>
          </Show>
        </div>
      </aside>
    </div>
  )
}

function viewIdentity(state: DesktopState | undefined) {
  return JSON.stringify([
    state?.configuration.workspace?.id,
    state?.configuration.workspace?.path,
    state?.configuration.runtime ?? "codex",
    state?.configuration.executable,
    state?.configuration.nativeHome,
    state?.session?.id,
    state?.history?.id,
  ])
}

function count(value: number | null | undefined) {
  return value === null || value === undefined ? copy.unknown : value.toLocaleString()
}

function selectableSkill(skill: SkillDescriptor, invocation: "user" | "model") {
  return (
    skill.metadataStatus !== "partial" &&
    !skill.observedFeatures.length &&
    !skill.declared.unknownFields.length &&
    skill.invocation[invocation] === "allowed-by-metadata"
  )
}
