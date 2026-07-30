import { request } from './client'
import type { AmazonConfigStatus, DashboardStats } from './types'

export async function getDashboardStats(): Promise<DashboardStats> {
  return request<DashboardStats>('/api/v1/admin/dashboard')
}

export async function getAmazonConfigStatus(): Promise<AmazonConfigStatus> {
  return request<AmazonConfigStatus>('/api/v1/admin/amazon-config-status')
}
