import { useId, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { useDialogFocus } from './useDialogFocus';

type Props = {
  title: string;
  icon: IconName;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  headExtra?: ReactNode;
  /**
   * 让 body 变成固定高度的 flex 列、把滚动权交给子组件（backlog #073）。
   * 聊天这类「内部自带滚动区 + 底部固定输入框」的面板需要它：
   * 否则 body 自身成为滚动层，输入框会被长历史推到折叠线以下。
   */
  fillBody?: boolean;
};

/** 游戏内浮层窗口：羊皮纸面板 + 标题栏 + 关闭按钮 */
export function Overlay({ title, icon, onClose, children, wide, headExtra, fillBody }: Props) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`gs-panel overlay-panel ${wide ? 'wide' : ''} ${fillBody ? 'overlay-panel--fill' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="overlay-head">
          <div className="overlay-title" id={titleId}>
            <Icon name={icon} size={24} color="var(--warm-deep)" strokeWidth={2} />
            {title}
          </div>
          {headExtra}
          <button type="button" className="gs-iconbtn" style={{ width: 38, height: 38 }} onClick={onClose} aria-label="关闭">
            <Icon name="close" size={18} strokeWidth={2.4} />
          </button>
        </div>
        <div className={`overlay-body ${fillBody ? 'overlay-body--fill' : ''}`}>{children}</div>
      </div>
    </div>
  );
}
