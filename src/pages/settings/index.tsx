/**
 * Settings shell: left icon menu + right content area (modeled on joybuddy's
 * settings). Panel switching is managed with a controlled activeKey + onChange
 * (no nested Router, to avoid conflicting with the main RouterProvider).
 */
import { type ComponentType, createElement } from 'react';
import { ConfigProvider, Menu } from 'antd';
import { useTranslation } from 'react-i18next';
import { SettingOutlined, DiffOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { menuSkinTheme } from '../../menu-skin';
import { GeneralTab } from './general';
import { IgnoreTab } from './ignore';
import { AboutTab } from './about';

type IconComp = ComponentType;
const TABS: { key: string; labelKey: string; icon: IconComp }[] = [
  { key: 'general', labelKey: 'general', icon: SettingOutlined },
  { key: 'ignore', labelKey: 'ignore', icon: DiffOutlined },
  { key: 'about', labelKey: 'about', icon: InfoCircleOutlined },
];

export { GeneralTab, IgnoreTab };

interface SettingsShellProps {
  /** The currently active panel key. */
  activeKey: string;
  /** Switch panels. */
  onChange: (key: string) => void;
}

export function SettingsShell({ activeKey, onChange }: SettingsShellProps) {
  const { t } = useTranslation('settings');
  const active = TABS.some((t) => t.key === activeKey) ? activeKey : 'general';

  return (
    <div className="flex h-full overflow-hidden [&>*]:min-h-0 [&>*]:min-w-0">
      {/* Left icon menu: uses antd Menu (controlled selectedKeys) with the shared
          Menu skin (menuSkinTheme + .pc-menu-skin, same as the sidebar). No background
          here — the modal panel carries the frosted-glass layer (.pc-glass-modal). */}
      <nav className="box-border w-[180px] shrink-0 h-full overflow-auto border-r border-line px-2 py-4">
        <ConfigProvider theme={menuSkinTheme}>
          <Menu
            mode="inline"
            selectedKeys={[active]}
            onClick={({ key }) => onChange(key)}
            className="pc-menu-skin"
            items={TABS.map((tab) => ({
              key: tab.key,
              icon: createElement(tab.icon),
              label: t(tab.labelKey),
            }))}
          />
        </ConfigProvider>
      </nav>

      {/* Right content area: a fixed title strip (.pc-settings-header) on top, the
          scroll area below it (box-border: this project ships no global border-box
          reset (no Tailwind preflight), and h-full + vertical padding would otherwise
          overflow the pane by exactly the padding — clipping the bottom of the scroll
          area). */}
      <div className="flex flex-1 min-w-0 h-full flex-col">
        {/* pointer-events-none: clicks pass through to the Modal's close button (which
            sits in this strip's top-right corner). */}
        <div className="pc-settings-header pointer-events-none flex h-[54px] shrink-0 items-center px-6">
          <h3 className="m-0 text-md font-semibold">{t(active)}</h3>
        </div>
        <div className="box-border min-h-0 min-w-0 flex-1 overflow-auto px-6 pt-4 pb-8">
          {active === 'ignore' ? <IgnoreTab /> : active === 'about' ? <AboutTab /> : <GeneralTab />}
        </div>
      </div>
    </div>
  );
}
