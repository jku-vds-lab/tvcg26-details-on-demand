import type { RootState } from '../../store';

export type ClusterSettingsState = RootState['clusterSettings'];
export type VisualizationSettingsState = RootState['visualizationSettings'];
export type ClusterSettingKey = keyof ClusterSettingsState;
