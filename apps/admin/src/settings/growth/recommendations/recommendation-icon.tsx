/* eslint-disable camelcase */
import React, { useState } from 'react';

interface Props {
  title: string;
  favicon?: string | null;
  featured_image?: string | null;
  isGhostSite?: boolean;
}

const RecommendationIcon: React.FC<Props> = ({ title, favicon, featured_image, isGhostSite }) => {
  const [icon, setIcon] = useState(favicon || featured_image || null);

  const clearIcon = () => {
    setIcon(null);
  };

  if (!icon) {
    return <div className="relative size-6 shrink-0 rounded-sm"></div>;
  }

  const hint = isGhostSite ? 'This site supports one-click subscribe' : '';

  return (
    <div className="relative size-6 shrink-0 rounded-sm" title={hint}>
      <img alt={title} className="size-6 rounded-sm" src={icon} onError={clearIcon} />
      {isGhostSite && (
        <span aria-label="Supports one-click subscribe" className="text-xs">✓</span>
      )}
    </div>
  );
};

export default RecommendationIcon;
