'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDate, formatNumber } from '@/i18n/format';
import type { Locale } from '@/i18n/config';

/**
 * Daily request volume.
 *
 * Hand-drawn SVG rather than a charting library, for two reasons that matter
 * more here than convenience:
 *
 *  - DIRECTION. Every charting library assumes a left-to-right time axis. In an
 *    RTL layout the natural reading of "time moves forward" is right-to-left,
 *    and most libraries cannot express that without fighting them. Here the bar
 *    order simply follows the flex flow, so the oldest day sits at the reading
 *    start in both languages.
 *  - Accessibility. The same data is emitted as a real <table> for screen
 *    readers, so the chart is not a picture with no content behind it.
 *
 * The stack stays lighter too: no ~100 KB of chart runtime for one bar chart.
 */

interface Point {
  date: string;
  total: number;
  completed: number;
  failed: number;
}

export function RequestsChart({ series, locale }: { series: Point[]; locale: Locale }) {
  const t = useTranslations('analytics.charts');
  const tDashboard = useTranslations('dashboard.metrics');
  const [hovered, setHovered] = useState<number | null>(null);

  const max = useMemo(
    () => Math.max(1, ...series.map((point) => point.total)),
    [series],
  );

  if (series.length === 0 || series.every((point) => point.total === 0)) {
    return <p className="py-8 text-center text-sm text-[var(--text-muted)]">{t('noData')}</p>;
  }

  return (
    <div>
      {/* The bars. `flex` order follows the document direction, so the earliest
          day is at the reading start without any mirroring logic. */}
      <div
        className="flex h-48 items-end gap-0.5"
        role="img"
        aria-label={t('requestsOverTime')}
      >
        {series.map((point, index) => {
          const completedHeight = (point.completed / max) * 100;
          const failedHeight = (point.failed / max) * 100;

          return (
            <div
              key={point.date}
              className="relative flex h-full flex-1 flex-col justify-end"
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(null)}
            >
              {point.failed > 0 ? (
                <div
                  className="w-full rounded-t-sm bg-[var(--status-danger-fg)]"
                  style={{ blockSize: `${failedHeight}%` }}
                />
              ) : null}
              <div
                className="w-full bg-[var(--color-brand-500)]"
                style={{
                  blockSize: `${completedHeight}%`,
                  borderStartStartRadius: point.failed > 0 ? 0 : '2px',
                  borderStartEndRadius: point.failed > 0 ? 0 : '2px',
                }}
              />

              {hovered === index && point.total > 0 ? (
                <div className="pointer-events-none absolute inset-block-start-0 z-10 -translate-y-full whitespace-nowrap rounded-[var(--radius-control)] bg-[var(--surface-inverse)] px-2 py-1 text-xs text-[var(--text-inverse)] shadow-[var(--shadow-raised)]">
                  <span className="block">{formatDate(point.date, locale)}</span>
                  <span className="block tabular-nums">
                    {formatNumber(point.total, locale)}
                  </span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-[var(--text-secondary)]">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-[var(--color-brand-500)]" aria-hidden="true" />
          {tDashboard('successfulRequests')}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="size-2.5 rounded-sm bg-[var(--status-danger-fg)]"
            aria-hidden="true"
          />
          {tDashboard('failedRequests')}
        </span>
      </div>

      {/* The same data, available to a screen reader and to anyone who prefers
          numbers. Visually hidden, not display:none, so it is announced. */}
      <table className="sr-only">
        <caption>{t('requestsOverTime')}</caption>
        <thead>
          <tr>
            <th scope="col">{formatDate(series[0]!.date, locale)}</th>
            <th scope="col">{tDashboard('totalRequests')}</th>
            <th scope="col">{tDashboard('successfulRequests')}</th>
            <th scope="col">{tDashboard('failedRequests')}</th>
          </tr>
        </thead>
        <tbody>
          {series
            .filter((point) => point.total > 0)
            .map((point) => (
              <tr key={point.date}>
                <th scope="row">{formatDate(point.date, locale)}</th>
                <td>{formatNumber(point.total, locale)}</td>
                <td>{formatNumber(point.completed, locale)}</td>
                <td>{formatNumber(point.failed, locale)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
