'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter, Link } from '@/i18n/routing';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Input,
  Spinner,
  Textarea,
  cn,
} from '@/components/ui/primitives';
import {
  IconKnowledge,
  IconSend,
  IconPlus,
  IconSearch,
  IconCopy,
  IconRefresh,
  IconDocument,
  IconGlobe,
  IconThumbUp,
  IconThumbDown,
} from '@/components/ui/icons';
import { ErrorMessage } from '@/components/auth/error-message';
import { apiFetch, ApiError } from '@/components/auth/api-error';
import { formatRelativeTime, detectDirection } from '@/i18n/format';
import type { Locale } from '@/i18n/config';

/**
 * Knowledge Agent workspace (§16).
 *
 * Two direction concerns are handled explicitly here, because a chat is where
 * bidirectional text actually breaks:
 *
 *  1. The UI language and the *message* language can differ. Someone using the
 *     Arabic interface may paste an English policy question. Each bubble
 *     therefore gets its own `dir`, detected from its first strong character,
 *     so an English answer inside an Arabic UI still reads left-to-right.
 *  2. Citations are filenames and URLs — Latin runs inside Arabic prose. They
 *     are isolated so the bidi algorithm cannot move ".pdf" to the wrong end.
 */

interface ConversationSummary {
  id: string;
  title: string;
  lastMessageAt: string;
  messageCount: number;
}

interface Citation {
  kind: 'document' | 'web';
  label: string;
  url?: string;
}

interface Message {
  id: string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  content: string;
  citations: Citation[];
  sourceBasis: string | null;
  feedback: number | null;
  createdAt: string;
}

interface SourceStatus {
  displayName: string;
  documentCount: number | null;
  lastSyncedAt: string | null;
  lastSyncStatus: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | null;
  reindexIntervalHours: number;
  recentFailures: number;
}

export function KnowledgeWorkspace({
  initialConversations,
  activeConversationId,
  initialMessages,
  source,
  configured,
}: {
  initialConversations: ConversationSummary[];
  activeConversationId: string | null;
  initialMessages: Message[];
  source: SourceStatus | null;
  configured: boolean;
}) {
  const t = useTranslations('knowledge');
  const locale = useLocale() as Locale;
  const router = useRouter();

  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [question, setQuestion] = useState('');
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest turn in view as the conversation grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, pending]);

  useEffect(() => {
    setMessages(initialMessages);
  }, [initialMessages]);

  const filtered = search.trim()
    ? initialConversations.filter((conversation) =>
        conversation.title.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : initialConversations;

  async function ensureConversation(): Promise<string> {
    if (activeConversationId) return activeConversationId;
    const created = await apiFetch<{ id: string }>('/api/v1/knowledge/conversations', {
      method: 'POST',
      body: JSON.stringify({ title: question.slice(0, 120), locale }),
    });
    return created.id;
  }

  async function send(text: string) {
    if (!text.trim() || pending) return;

    setError(null);
    setPending(true);

    // The question appears immediately with a provisional id. If the agent
    // fails, it stays on screen with a retry — losing what someone typed
    // because a downstream service was slow is not acceptable.
    const optimisticId = `pending-${Date.now()}`;
    setMessages((current) => [
      ...current,
      {
        id: optimisticId,
        role: 'USER',
        content: text,
        citations: [],
        sourceBasis: null,
        feedback: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    setQuestion('');

    try {
      const conversationId = await ensureConversation();

      const result = await apiFetch<{
        conversationId: string;
        userMessageId: string;
        assistantMessageId?: string;
        result?: { answer: string; citations: Citation[]; sourceBasis: string };
        error?: { code: string; retryable: boolean };
      }>(`/api/v1/knowledge/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ question: text }),
      });

      if (result.error) {
        setError(new ApiError({ code: result.error.code, reference: '' }, 200));
        setMessages((current) =>
          current.map((message) =>
            message.id === optimisticId ? { ...message, id: result.userMessageId } : message,
          ),
        );
      } else if (result.result && result.assistantMessageId) {
        setMessages((current) => [
          ...current.map((message) =>
            message.id === optimisticId ? { ...message, id: result.userMessageId } : message,
          ),
          {
            id: result.assistantMessageId!,
            role: 'ASSISTANT',
            content: result.result!.answer,
            citations: result.result!.citations,
            sourceBasis: result.result!.sourceBasis,
            feedback: null,
            createdAt: new Date().toISOString(),
          },
        ]);
      }

      if (!activeConversationId) {
        router.replace(`/knowledge/${result.conversationId}`);
        router.refresh();
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
    } finally {
      setPending(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void send(question);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter inserts a newline — the convention every chat
    // user already has in their fingers.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send(question);
    }
  }

  async function copyAnswer(message: Message) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Clipboard access denied; nothing useful to show the user.
    }
  }

  async function rate(message: Message, feedback: 1 | -1) {
    const next = message.feedback === feedback ? null : feedback;
    setMessages((current) =>
      current.map((entry) => (entry.id === message.id ? { ...entry, feedback: next } : entry)),
    );

    try {
      await apiFetch(`/api/v1/knowledge/messages/${message.id}/feedback`, {
        method: 'PATCH',
        body: JSON.stringify({ feedback: next }),
      });
    } catch {
      // Revert on failure so the UI never claims a rating that was not stored.
      setMessages((current) =>
        current.map((entry) =>
          entry.id === message.id ? { ...entry, feedback: message.feedback } : entry,
        ),
      );
    }
  }

  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'USER');

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)_16rem]">
      {/* --- Conversation list ------------------------------------------- */}
      <aside className="order-2 lg:order-1">
        <Card className="flex h-full flex-col">
          <div className="space-y-3 border-b border-[var(--border-subtle)] p-3">
            <Link href="/knowledge" className="block">
              <Button fullWidth iconStart={<IconPlus className="size-4" />}>
                {t('newConversation')}
              </Button>
            </Link>
            <div className="relative">
              <IconSearch className="pointer-events-none absolute inset-block-0 start-2.5 my-auto size-4 text-[var(--text-muted)]" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('searchConversations')}
                aria-label={t('searchConversations')}
                className="ps-9"
              />
            </div>
          </div>

          <div className="scrollbar-slim max-h-[28rem] flex-1 overflow-y-auto p-2">
            {filtered.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-[var(--text-muted)]">
                {t('noConversations.title')}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {filtered.map((conversation) => (
                  <li key={conversation.id}>
                    <Link
                      href={`/knowledge/${conversation.id}`}
                      aria-current={conversation.id === activeConversationId ? 'page' : undefined}
                      className={cn(
                        'block rounded-[var(--radius-control)] px-3 py-2 transition-colors',
                        conversation.id === activeConversationId
                          ? 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-raised)]',
                      )}
                    >
                      <span className="line-clamp-2 text-sm">{conversation.title}</span>
                      <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
                        {formatRelativeTime(conversation.lastMessageAt, locale)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </aside>

      {/* --- Chat --------------------------------------------------------- */}
      <section className="order-1 lg:order-2" aria-label={t('title')}>
        <Card className="flex h-[calc(100dvh-9rem)] flex-col">
          {!configured ? (
            <div className="p-4">
              <Alert tone="warning" title={t('sourcePanel.notConnected.title')}>
                {t('sourcePanel.notConnected.body')}
              </Alert>
            </div>
          ) : null}

          <div
            ref={scrollRef}
            className="scrollbar-slim flex-1 space-y-4 overflow-y-auto p-4"
            // A live region so a screen reader announces the agent's answer as
            // it arrives rather than leaving the user to discover it.
            aria-live="polite"
            aria-busy={pending}
          >
            {messages.length === 0 ? (
              <EmptyState
                icon={<IconKnowledge className="size-6" />}
                title={t('emptyChat.title')}
                body={t('emptyChat.body')}
              />
            ) : (
              messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  onCopy={() => copyAnswer(message)}
                  copied={copiedId === message.id}
                  onRate={(value) => rate(message, value)}
                />
              ))
            )}

            {pending ? (
              <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <Spinner className="size-4" />
                {t('message.thinking')}
              </div>
            ) : null}

            {error ? (
              <div className="space-y-2">
                <ErrorMessage error={error} />
                {lastUserMessage ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    iconStart={<IconRefresh className="size-4" />}
                    onClick={() => void send(lastUserMessage.content)}
                  >
                    {t('message.retry')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          <form
            onSubmit={handleSubmit}
            className="border-t border-[var(--border-subtle)] p-3"
          >
            <div className="flex items-end gap-2">
              <Textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('composer.placeholder')}
                aria-label={t('composer.placeholder')}
                rows={2}
                disabled={!configured || pending}
                // `auto` lets the browser pick per content: an Arabic question
                // in an English UI still types right-to-left.
                dir="auto"
                className="min-h-11 flex-1"
              />
              <Button
                type="submit"
                loading={pending}
                disabled={!configured || question.trim().length === 0}
                aria-label={t('composer.send')}
                size="lg"
              >
                <IconSend className="size-4" />
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-[var(--text-muted)]">{t('composer.hint')}</p>
          </form>
        </Card>
      </section>

      {/* --- Source panel -------------------------------------------------- */}
      <aside className="order-3 xl:order-3">
        <SourcePanel source={source} />
      </aside>
    </div>
  );
}

function MessageBubble({
  message,
  onCopy,
  copied,
  onRate,
}: {
  message: Message;
  onCopy: () => void;
  copied: boolean;
  onRate: (value: 1 | -1) => void;
}) {
  const t = useTranslations('knowledge');
  const isUser = message.role === 'USER';

  // The message's own direction, which may differ from the UI's.
  const direction = detectDirection(message.content);

  return (
    <div className={cn('flex flex-col gap-1.5', isUser ? 'items-end' : 'items-start')}>
      <span className="text-xs font-medium text-[var(--text-muted)]">
        {isUser ? t('message.you') : t('message.agent')}
      </span>

      <div
        dir={direction}
        className={cn(
          'max-w-[85%] whitespace-pre-wrap rounded-[var(--radius-card)] px-4 py-3 text-sm leading-relaxed',
          isUser
            ? 'bg-[var(--color-brand-600)] text-white'
            : 'bg-[var(--surface-sunken)] text-[var(--text-primary)]',
        )}
      >
        {message.content}
      </div>

      {!isUser && message.citations.length > 0 ? (
        <SourcesList citations={message.citations} basis={message.sourceBasis} />
      ) : null}

      {!isUser ? (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onCopy} aria-label={t('message.copy')}>
            <IconCopy className="size-3.5" />
            <span className="text-xs">{copied ? t('message.copied') : t('message.copy')}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRate(1)}
            aria-label={t('message.helpful')}
            aria-pressed={message.feedback === 1}
            className={message.feedback === 1 ? 'text-[var(--status-success-fg)]' : undefined}
          >
            <IconThumbUp className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRate(-1)}
            aria-label={t('message.notHelpful')}
            aria-pressed={message.feedback === -1}
            className={message.feedback === -1 ? 'text-[var(--status-danger-fg)]' : undefined}
          >
            <IconThumbDown className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SourcesList({ citations, basis }: { citations: Citation[]; basis: string | null }) {
  const t = useTranslations('knowledge.sources');

  const basisKey =
    basis === 'documents' || basis === 'web' || basis === 'both' ? basis : 'none';

  return (
    <div className="max-w-[85%] rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-[var(--text-primary)]">{t('title')}</span>
        <Badge tone={basisKey === 'documents' ? 'success' : basisKey === 'web' ? 'info' : 'neutral'}>
          {t(`basis.${basisKey}`)}
        </Badge>
      </div>

      <ul className="space-y-1.5">
        {citations.map((citation, index) => (
          <li key={`${citation.kind}-${citation.label}-${index}`} className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 text-[var(--text-muted)]">
              {citation.kind === 'document' ? (
                <IconDocument className="size-3.5" />
              ) : (
                <IconGlobe className="size-3.5" />
              )}
            </span>
            {citation.url ? (
              <a
                href={citation.url}
                target="_blank"
                // noreferrer alongside noopener: the target must not learn
                // which tenant page linked to it.
                rel="noopener noreferrer"
                className="bidi-isolate break-all text-xs text-[var(--text-brand)] hover:underline"
              >
                {citation.label}
              </a>
            ) : (
              // A filename is a Latin run inside possibly-Arabic prose; isolate
              // it so the extension does not migrate to the wrong end.
              <span className="bidi-isolate break-all text-xs text-[var(--text-secondary)]">
                {citation.label}
              </span>
            )}
          </li>
        ))}
      </ul>

      {/* Says plainly where these came from: the workflow returns no structured
          sources array, so they were parsed out of the answer text. */}
      <p className="mt-2 text-[11px] text-[var(--text-muted)]">{t('parsedNotice')}</p>
    </div>
  );
}

function SourcePanel({ source }: { source: SourceStatus | null }) {
  const t = useTranslations('knowledge.sourcePanel');
  const locale = useLocale() as Locale;

  if (!source) {
    return (
      <Card>
        <CardBody>
          <Alert tone="info" title={t('notConnected.title')}>
            {t('notConnected.body')}
          </Alert>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t('title')}</h2>

        <dl className="space-y-2 text-xs">
          <div>
            <dt className="text-[var(--text-muted)]">{t('folder')}</dt>
            <dd className="bidi-isolate mt-0.5 text-[var(--text-primary)]">
              {source.displayName}
            </dd>
          </div>

          <div>
            <dt className="text-[var(--text-muted)]">{t('documents')}</dt>
            <dd className="mt-0.5 text-[var(--text-primary)]">
              {source.documentCount === null ? (
                // Not "0": the workflow simply does not report a count.
                <span className="text-[var(--text-muted)]">{t('documentsUnknown')}</span>
              ) : (
                source.documentCount
              )}
            </dd>
          </div>

          <div>
            <dt className="text-[var(--text-muted)]">{t('lastSync')}</dt>
            <dd className="mt-0.5 text-[var(--text-primary)]">
              {source.lastSyncedAt ? formatRelativeTime(source.lastSyncedAt, locale) : '—'}
            </dd>
          </div>

          <div>
            <dt className="text-[var(--text-muted)]">{t('supportedFormats')}</dt>
            <dd className="mt-0.5 text-[var(--text-primary)]">{t('formats')}</dd>
          </div>
        </dl>

        <p className="text-[11px] text-[var(--text-muted)]">
          {t('syncInterval', { hours: source.reindexIntervalHours })}
        </p>

        {source.recentFailures > 0 ? (
          <Badge tone="danger" dot>
            {source.recentFailures}
          </Badge>
        ) : null}
      </CardBody>
    </Card>
  );
}
