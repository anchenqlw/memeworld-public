import type { ChronicleEntry } from '../../api/client';
import { Icon } from '../ui/Icon';
import { Overlay } from '../ui/Overlay';

type Props = { entries: ChronicleEntry[]; onClose: () => void };

export type ChronicleDay = { date: string; entries: ChronicleEntry[] };

export function groupChronicleEntries(entries: ChronicleEntry[]): ChronicleDay[] {
  const days: ChronicleDay[] = [];
  for (const entry of entries) {
    const current = days.at(-1);
    if (current?.date === entry.date) current.entries.push(entry);
    else days.push({ date: entry.date, entries: [entry] });
  }
  return days;
}

export function ChroniclePanel({ entries, onClose }: Props) {
  const days = groupChronicleEntries(entries);
  return (
    <Overlay title="世界编年史" icon="journal" onClose={onClose}>
      <section className="pika-panel-hero pika-panel-hero--chronicle">
        <img src="/assets/game/creator/pika-chronicle.png" alt="皮卡打开世界编年史" />
        <div>
          <span className="pika-kicker">皮卡的世界档案室</span>
          <h3>每一次进化，都不会被遗忘</h3>
          <p>地点、事件和玩法的变化会自动记在这里。若灵感来自玩家，还会留下贡献小猫的名字。</p>
        </div>
      </section>

      {entries.length === 0 ? (
        <div className="asset-placeholder" style={{ padding: '24px 16px' }}>
          <Icon name="journal" size={28} color="var(--ink-soft)" />
          <span>编年史正在从仓库同步，稍后再来翻阅</span>
        </div>
      ) : (
        <ol className="chronicle-list" aria-label="世界进化记录">
          {days.map((day, dayIndex) => (
            <li key={day.date} className="chronicle-day">
              <span className="chronicle-day__dot" aria-hidden="true" />
              <div className="chronicle-day__label">
                <time dateTime={day.date}>{day.date}</time>
                <small>{day.entries.length} 件小事</small>
              </div>
              <ol className="chronicle-day__entries">
                {day.entries.map((entry, entryIndex) => (
                  <li key={entry.id} className="chronicle-entry">
                    <article className="chronicle-entry__card">
                      <div className="chronicle-entry__head">
                        <span>{entry.change_type}</span>
                        {dayIndex === 0 && entryIndex === 0 && <em>刚刚发生</em>}
                      </div>
                      <h3>{entry.title}</h3>
                      <p>{entry.summary}</p>
                      {entry.source_kind === 'proposal' && entry.contributor_cat_name && (
                        <strong className="chronicle-credit">by {entry.contributor_cat_name} 主人</strong>
                      )}
                    </article>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </Overlay>
  );
}
