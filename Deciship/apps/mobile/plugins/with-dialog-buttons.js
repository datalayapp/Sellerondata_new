/**
 * Android diyalog düğmelerini büyük harfe çevirmez.
 * Malzeme teması düğme metnini cihazın diliyle büyütür: cihaz İngilizce, uygulama Türkçe olunca "Yeniden ölç" "YENIDEN ÖLÇ",
 * "Kalıcı olarak sil" "KALICI OLARAK SIL" olur. Metin yazıldığı gibi kalır.
 */
const { withAndroidStyles } = require('expo/config-plugins');

const DIALOG = 'SodAlertDialog';
const BUTTON = 'SodDialogButton';

const item = (name, value) => ({ $: { name }, _: value });

function applyDialogStyles(resources) {
  const styles = (resources.style ?? []).filter((s) => s.$.name !== DIALOG && s.$.name !== BUTTON);
  const appTheme = styles.find((s) => s.$.name === 'AppTheme');
  if (appTheme) {
    appTheme.item = [...(appTheme.item ?? []).filter((i) => i.$.name !== 'alertDialogTheme'), item('alertDialogTheme', `@style/${DIALOG}`)];
  }
  styles.push({
    $: { name: DIALOG, parent: 'ThemeOverlay.AppCompat.Dialog.Alert' },
    item: [
      item('buttonBarPositiveButtonStyle', `@style/${BUTTON}`),
      item('buttonBarNegativeButtonStyle', `@style/${BUTTON}`),
      item('buttonBarNeutralButtonStyle', `@style/${BUTTON}`),
    ],
  });
  styles.push({
    $: { name: BUTTON, parent: 'Widget.AppCompat.Button.ButtonBar.AlertDialog' },
    item: [item('android:textAllCaps', 'false'), item('textAllCaps', 'false')],
  });
  return { ...resources, style: styles };
}

module.exports = function withDialogButtons(config) {
  return withAndroidStyles(config, (cfg) => {
    cfg.modResults.resources = applyDialogStyles(cfg.modResults.resources);
    return cfg;
  });
};
module.exports.applyDialogStyles = applyDialogStyles;
