import { LIMITS, settingsDeclarationSchema, type SettingField } from 'kehikot-module-protocol'

/**
 * The Editor's one setting, the person's keyboard shortcuts, as the manifest declares it. Pure, so
 * the manifest (which the page imports for the module's id) never pulls the server's file code in.
 * Read and written by the server (`file/keybindings.ts`).
 */
export const KEYBINDINGS_KEY = 'keybindings'

/** The setting, as the manifest declares it. */
export const SETTINGS: SettingField[] = settingsDeclarationSchema.parse([
  {
    key: KEYBINDINGS_KEY,
    label: 'Keyboard shortcuts (JSON)',
    description:
      'Your own keys over the Editor’s defaults, in VS Code’s keybindings.json shape: [{ "key": "cmd+e", "command": "palette.show" }]. '
      + '"-command" takes a default away. Open keyboard shortcuts (JSON) in the Editor checks it as you type.',
    type: 'string',
    default: '',
    scope: 'machine',
  },
])

/** The longest list the setting holds: the protocol's bound on a text setting. */
export const MAX_KEYBINDINGS_TEXT = LIMITS.SETTING_TEXT

