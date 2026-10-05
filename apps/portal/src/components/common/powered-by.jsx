import React from 'react';
import AppContext from '../../app-context';
import GhostLogo from '../../images/ghost-logo-small.svg?react';

export default class PoweredBy extends React.Component {
  static contextType = AppContext;

  render() {
    // Note: please do not wrap "Powered by Frontro" in the translation function, as we don't
    // want it to be translated
    /* eslint-disable i18next/no-literal-string */
    return (
      <a href="https://frontro.com" target="_blank" rel="noopener noreferrer">
        <GhostLogo />
        Powered by Frontro
      </a>
    );
    /* eslint-enable i18next/no-literal-string */
  }
}
