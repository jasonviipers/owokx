import { AnimatePresence, motion } from "motion/react";
import { SettingsModal } from "../components/SettingsModal";
import type { Config } from "../types";

interface SettingsPageProps {
  show: boolean;
  config: Config | null | undefined;
  onSave: (nextConfig: Config) => Promise<void>;
  onClose: () => void;
  onReset: () => Promise<void>;
}

export function SettingsPage({ show, config, onSave, onClose, onReset }: SettingsPageProps) {
  return (
    <AnimatePresence>
      {show && config && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <SettingsModal config={config} onSave={onSave} onClose={onClose} onReset={onReset} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
