/**
 * MailService.gs
 * Outbound mail. Currently one message: the link on which a user sets their
 * own password.
 *
 * No password is ever sent by mail — not an initial one, not a temporary one.
 * What travels is a signed, expiring, single-use link on which the recipient
 * chooses their own. There is therefore no window in which an account has a
 * password that the sender also knows.
 *
 * Quota note: MailApp allows 100 recipients a day on consumer Gmail accounts
 * and 1500 on Workspace. Mail leaves from the script owner's address, so check
 * the first delivery does not land in spam.
 */

const MailService = (function () {

  function _setPasswordUrl(token) {
    return `${Config.getFrontendUrl()}#/set-password?k=${encodeURIComponent(token)}`;
  }

  function _appName() {
    return Config.getString('appName', 'Handover');
  }

  /**
   * @param user     the Users row
   * @param token    a setpw token from AuthService.generateSetPasswordToken
   * @param isReset  false for a new account, true for a reset of an existing one
   */
  function sendSetPasswordLink(user, token, isReset) {
    const url = _setPasswordUrl(token);
    const hours = Config.getSetPasswordTtlHours();
    const app = _appName();

    const subject = isReset
      ? `${app} — set a new password`
      : `${app} — your access`;

    const opening = isReset
      ? 'A new password has been requested for your account.'
      : `An account has been created for you in ${app}.`;

    const body = [
      `Hello ${user.name},`,
      '',
      opening,
      '',
      'Open the link below to choose your password:',
      url,
      '',
      `The link is valid for ${hours} hours and can be used once.`,
      'It stops working as soon as a password is set.',
      '',
      'If you were not expecting this message, you can ignore it — nothing',
      'changes until the link is opened.',
      '',
      `— ${app}`,
    ].join('\n');

    try {
      MailApp.sendEmail({ to: user.email, subject: subject, body: body });
      Utils.log('INFO', 'Set-password link sent', { userId: user.userId, isReset: !!isReset });
      return true;
    } catch (e) {
      Utils.log('ERROR', 'Set-password mail failed', {
        userId: user.userId, error: e.message,
      });
      throw new HandoverError(
        'INTERNAL_ERROR',
        'The account was saved but the email could not be sent. ' +
        'Check the MailApp quota, then send the link again.'
      );
    }
  }

  return { sendSetPasswordLink };
})();
