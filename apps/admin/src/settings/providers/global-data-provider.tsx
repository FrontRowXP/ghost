import frontroIcon from '@/assets/img/frontro-icon.svg';
import { GlobalDataContext } from './global-data-context';
import { useBrowseConfig } from '@tryghost/admin-x-framework/api/config';
import { type ReactNode } from 'react';
import { useBrowseSettings } from '@tryghost/admin-x-framework/api/settings';
import { useBrowseSite } from '@tryghost/admin-x-framework/api/site';
import { useCurrentUser } from '@tryghost/admin-x-framework/api/current-user';

const GlobalDataProvider = ({ children }: { children: ReactNode }) => {
  const settings = useBrowseSettings();
  const site = useBrowseSite();
  const config = useBrowseConfig();
  const currentUser = useCurrentUser();
  const requests = [settings, site, config, currentUser];

  const error = requests.map((request) => request.error).find(Boolean);

  if (error) {
    throw error;
  }

  if (requests.some((request) => request.isLoading)) {
    return (
      <div
        className="gh-loading-orb-container"
        style={{
          width: '100vw',
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          paddingBottom: '8vh',
        }}
      >
        <img alt="Frontro" className="gh-loading-orb" height="100" src={frontroIcon} width="100" />
      </div>
    );
  }

  return (
    <GlobalDataContext.Provider
      value={{
        settings: settings.data!.settings,
        siteData: site.data!.site,
        config: config.data!.config,
        currentUser: currentUser.data!,
      }}
    >
      {children}
    </GlobalDataContext.Provider>
  );
};

export default GlobalDataProvider;
