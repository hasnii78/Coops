import { NavLink } from 'react-router-dom';

import { IconCloset, IconCombos, IconMe, IconSaved, IconProfile } from './Icons';

// Five tabs. The Inbox tab was removed along with the chat feature.
const TABS = [
  { to: '/closet', label: 'Closet', Icon: IconCloset },
  { to: '/combos', label: 'Combos', Icon: IconCombos },
  { to: '/me', label: 'Me', Icon: IconMe },
  { to: '/saved', label: 'Saved', Icon: IconSaved },
  { to: '/profile', label: 'Profile', Icon: IconProfile },
];

export default function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="Main">
      {TABS.map(({ to, label, Icon }) => (
        <NavLink key={to} to={to}>
          <Icon aria-hidden="true" />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
