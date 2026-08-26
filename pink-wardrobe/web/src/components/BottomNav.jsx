import { NavLink } from 'react-router-dom';
import {
  IconCloset, IconCombos, IconMe, IconSaved, IconInbox, IconProfile,
} from './Icons';

const TABS = [
  { to: '/closet', label: 'Closet', Icon: IconCloset },
  { to: '/combos', label: 'Combos', Icon: IconCombos },
  { to: '/me', label: 'Me', Icon: IconMe },
  { to: '/saved', label: 'Saved', Icon: IconSaved },
  { to: '/inbox', label: 'Inbox', Icon: IconInbox },
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
