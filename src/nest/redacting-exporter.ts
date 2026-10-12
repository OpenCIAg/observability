import type { Attributes, AttributeValue } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter, TimedEvent } from '@opentelemetry/sdk-trace-base';
import { REDACTED, isSensitiveKey, redactString, redactUrl } from '../core/redact';

const URL_KEYS = new Set(['url.full', 'url.query', 'http.url', 'http.target', 'url.path']);
const HEADER_PREFIXES = ['http.request.header.', 'http.response.header.'];

function redactAttributeValue(key: string, value: AttributeValue | undefined): AttributeValue | undefined {
  if (value === undefined) return value;
  const last = key.split('.').pop() ?? key;
  const header = HEADER_PREFIXES.find((p) => key.startsWith(p));
  if (isSensitiveKey(last) || (header !== undefined && isSensitiveKey(key.slice(header.length)))) return REDACTED;
  if (typeof value === 'string') {
    if (key === 'url.query') return redactUrl(`?${value}`).slice(1);
    return URL_KEYS.has(key) ? redactUrl(value) : redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? redactString(v) : v)) as AttributeValue;
  }
  return value;
}

/** Atributos de span/evento com PII removida (chaves sensíveis, e-mails, tokens em URL). */
export function redactAttributes(attributes: Attributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) out[key] = redactAttributeValue(key, value);
  return out;
}

export function redactSpan(span: ReadableSpan): ReadableSpan {
  const events: TimedEvent[] = span.events.map((e) => ({
    ...e,
    attributes: e.attributes === undefined ? undefined : redactAttributes(e.attributes),
  }));
  return {
    name: redactString(span.name),
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status:
      span.status.message === undefined ? span.status : { ...span.status, message: redactString(span.status.message) },
    attributes: redactAttributes(span.attributes),
    links: span.links,
    events,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/** Exportador que aplica a redação antes de entregar ao exportador real (OTLP). */
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(spans.map(redactSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
