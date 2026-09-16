/**
 * Меню приложения.
 *
 * Кроме привычных ролей здесь живёт единственный способ управлять настройками:
 * пункт открывает `settings.json` тем редактором, который назначен в системе.
 * Экрана настроек в интерфейсе пока нет (см. docs/desktop.md), и меню — честная
 * замена: путь к файлу не приходится искать, а изменения применяются
 * перезапуском из соседнего пункта.
 */
import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

/** Что меню должно уметь открыть. */
export interface MenuTargets {
  /** Файл настроек. */
  settingsFile: string;
  /** Каталог с базой и материалами. */
  dataDir: string;
  /** Каталог журналов. */
  logDir: string;
}

/** Перезапускает приложение, чтобы применить правку настроек. */
function relaunch(): void {
  app.relaunch();
  app.quit();
}

/** Собирает меню приложения. */
export function buildMenu(targets: MenuTargets, getWindow: () => BrowserWindow | null): Menu {
  const isMac = process.platform === 'darwin';

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.getName(),
          submenu: [
            { role: 'about', label: `О программе ${app.getName()}` },
            { type: 'separator' },
            { role: 'hide', label: 'Скрыть' },
            { role: 'hideOthers', label: 'Скрыть остальные' },
            { role: 'unhide', label: 'Показать все' },
            { type: 'separator' },
            { role: 'quit', label: 'Завершить' },
          ],
        },
      ]
    : [];

  const fileMenu: MenuItemConstructorOptions = {
    label: 'Файл',
    submenu: [
      {
        label: 'Настройки…',
        accelerator: 'CmdOrCtrl+,',
        click: () => {
          void shell.openPath(targets.settingsFile);
        },
      },
      {
        label: 'Применить настройки (перезапуск)',
        click: relaunch,
      },
      { type: 'separator' },
      {
        label: 'Папка с данными',
        click: () => {
          void shell.openPath(targets.dataDir);
        },
      },
      {
        label: 'Папка с журналами',
        click: () => {
          void shell.openPath(targets.logDir);
        },
      },
      { type: 'separator' },
      isMac ? { role: 'close', label: 'Закрыть окно' } : { role: 'quit', label: 'Выход' },
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: 'Правка',
    submenu: [
      { role: 'undo', label: 'Отменить' },
      { role: 'redo', label: 'Повторить' },
      { type: 'separator' },
      { role: 'cut', label: 'Вырезать' },
      { role: 'copy', label: 'Копировать' },
      { role: 'paste', label: 'Вставить' },
      { role: 'selectAll', label: 'Выделить всё' },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: 'Вид',
    submenu: [
      {
        label: 'Обновить страницу',
        accelerator: 'CmdOrCtrl+R',
        click: () => {
          getWindow()?.webContents.reload();
        },
      },
      { role: 'toggleDevTools', label: 'Инструменты разработчика' },
      { type: 'separator' },
      { role: 'resetZoom', label: 'Обычный размер' },
      { role: 'zoomIn', label: 'Крупнее' },
      { role: 'zoomOut', label: 'Мельче' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Полный экран' },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Окно',
    submenu: [
      { role: 'minimize', label: 'Свернуть' },
      ...(isMac
        ? ([
            { role: 'zoom', label: 'Увеличить' },
            { role: 'front', label: 'Все окна вперёд' },
          ] as MenuItemConstructorOptions[])
        : []),
    ],
  };

  return Menu.buildFromTemplate([...appMenu, fileMenu, editMenu, viewMenu, windowMenu]);
}
