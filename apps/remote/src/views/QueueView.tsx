import { QueueList, useT } from '@hqps/ui';

export function QueueView() {
  const t = useT();
  return (
    <div className="rm-page">
      <h1 className="rm-h1">{t('queue.title')}</h1>
      <QueueList large />
    </div>
  );
}
