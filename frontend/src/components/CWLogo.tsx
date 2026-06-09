/**
 * City Wide Boston — Logo Components
 * Uses the official CWB logo asset.
 */

import cwLogo from '../assets/cw-logo.png';

/** Full-colour lockup — login page (light background) */
export function CWLogoFull({ className = '' }: { className?: string }) {
  return (
    <img
      src={cwLogo}
      alt="City Wide Facility Solutions Boston"
      className={className}
      style={{ maxWidth: '100%', height: 'auto' }}
    />
  );
}

/** Sidebar compact — white background card on dark sidebar */
export function CWLogoSidebar({ className = '' }: { className?: string }) {
  return (
    <img
      src={cwLogo}
      alt="City Wide Facility Solutions Boston"
      className={className}
      style={{ maxWidth: '100%', height: 'auto' }}
    />
  );
}

export default CWLogoSidebar;
