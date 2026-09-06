import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { HumanInputRequest, InteractionReview, PermissionRequest } from "@harness/protocol"
import type { DesktopState } from "../shared/contracts"
import { copy } from "./copy"
import { Icon } from "./icons"

type ContextTab = "activity" | "review" | "skills"

export function App() {
  const [state, setState] = createSignal<DesktopState>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [draft, setDraft] = createSignal("")
  const [modelId, setModelId] = createSignal("")
  const [acknowledgeOverage, setAcknowledgeOverage] = createSignal(false)
  const [allowFileChanges, setAllowFileChanges] = createSignal(false)
  const [acknowledgeBoundary, setAcknowledgeBoundary] = createSignal(false)
  const [contextOpen, setContextOpen] = createSignal(false)
  const [tab, setTab] = createSignal<ContextTab>("activity")
  const [reviews, setReviews] = createSignal<Record<string, InteractionReview>>({})
  const [selections, setSelections] = createSignal<Record<string, Record<string, string>>>({})
  const [now, setNow] = createSignal(Date.now())
  const configuration = () => state()?.configuration
  const runtime = () => configuration()?.runtime ?? "codex"
  const runtimeName = () => (runtime() === "claude" ? copy.claude : copy.codex)
  const executionAvailable = () => runtime() === "codex"
  const session = () => state()?.session
  const running = () => ["running", "awaiting-permission", "awaiting-input"].includes(session()?.status ?? "")
  const canSend = () =>
    executionAvailable() &&
    !busy() &&
    !!session() &&
    ["idle", "interrupted"].includes(session()!.status) &&
    !!draft().trim()
  const pending = () => (state()?.permissions.length ?? 0) + (state()?.inputs.length ?? 0)
  const ready = () => state()?.connection.status === "ready"
  const canStart = () =>
    !busy() &&
    executionAvailable() &&
    !session() &&
    ready() &&
    !!configuration()?.workspace &&
    !!modelId().trim() &&
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
    if ((current?.configuration.runtime ?? "codex") !== (next.configuration.runtime ?? "codex")) {
      setModelId("")
      setAcknowledgeOverage(false)
      setAllowFileChanges(false)
      setAcknowledgeBoundary(false)
      setDraft("")
      setReviews({})
      setSelections({})
    }
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
    try {
      const review = await window.harness.review({ kind, requestId })
      const current = kind === "permission" ? permissionIds() : inputIds()
      if (current.includes(requestId) && Date.parse(review.expiresAt) > Date.now()) {
        setReviews((previous) => ({ ...previous, [requestId]: review }))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failedRequest)
    } finally {
      setBusy(false)
    }
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
    const tabs: ContextTab[] = ["activity", "review", "skills"]
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
          <button
            class="new-session"
            disabled={!!session() || busy() || !state()}
            title={session() ? copy.singleSession : copy.newConversation}
            onClick={() => openContext()}
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
              onClick={() => void perform(() => window.harness.refresh())}
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
                  onClick={() => void perform(() => window.harness.refresh())}
                >
                  <Icon name="refresh" size={14} />
                  {copy.checkConnection}
                </button>
              </div>
              <Show when={!executionAvailable()}>
                <p class="attention">{copy.claudeUnavailable}</p>
              </Show>
              <Show when={executionAvailable()}>
                <label class="model-label" for="model-id">
                  {copy.modelLabel}
                </label>
                <input
                  id="model-id"
                  class="model-input"
                  type="text"
                  value={modelId()}
                  maxLength={128}
                  autocomplete="off"
                  spellcheck={false}
                  placeholder={copy.modelPlaceholder}
                  onInput={(event) => setModelId(event.currentTarget.value)}
                />
                <p class="model-hint">{copy.modelHint}</p>
                <p class="attention">{copy.overageNotice}</p>
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
              <button
                class="primary-button full-width"
                disabled={!canStart()}
                onClick={() =>
                  void perform(() =>
                    window.harness.start({
                      modelId: modelId().trim(),
                      acknowledgeOverage: acknowledgeOverage(),
                      allowFileChanges: allowFileChanges(),
                      acknowledgeUnverifiedBoundary: acknowledgeBoundary(),
                    }),
                  )
                }
              >
                {copy.startConversation}
              </button>
            </Show>
            <Show when={session()}>
              <p class="model-hint">
                {copy.sessionStarted}: {session()?.modelId}
              </p>
            </Show>
          </section>
          <div class="context-tabs" role="tablist" aria-label={copy.contextTabs} onKeyDown={tabKey}>
            <For each={["activity", "review", "skills"] as const}>
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
                  <Icon name={item === "activity" ? "activity" : item === "skills" ? "book" : "shield"} size={13} />
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
              <p class="attention">{copy.skillsPending}</p>
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
                    <p>{copy.skillDisabled}</p>
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
