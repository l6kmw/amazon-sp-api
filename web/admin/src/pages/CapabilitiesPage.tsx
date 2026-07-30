import { useEffect, useState } from 'react'
import styled from '@emotion/styled'
import { listCapabilities } from '../api/capabilities'
import type { AmazonCapability } from '../api/types'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { StatusBadge } from '../components/StatusBadge'
import { InlineAlert } from '../components/InlineAlert'

export function CapabilitiesPage() {
  const [capabilities, setCapabilities] = useState<AmazonCapability[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [domainFilter, setDomainFilter] = useState('all')
  const [availabilityFilter, setAvailabilityFilter] = useState('all')

  const loadCapabilities = async () => {
    setLoading(true)
    setError(null)
    try {
      const items = await listCapabilities({
        domain: domainFilter === 'all' ? undefined : domainFilter,
        availability: availabilityFilter === 'all' ? undefined : availabilityFilter
      })
      setCapabilities(items || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取 SP-API 能力目录失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadCapabilities()
  }, [domainFilter, availabilityFilter])

  return (
    <Container>
      <Header>
        <HeaderLeft>
          <Title>SP-API 能力目录 (Capability Catalog)</Title>
          <Subtitle>查看已集成的 Amazon SP-API 只读工具、领域 Action 及所需 Amazon Roles (本页面仅用于元信息展示)</Subtitle>
        </HeaderLeft>
        <Button variant="secondary" onClick={loadCapabilities} type="button">
          刷新
        </Button>
      </Header>

      <InlineAlert type="info">
        🔒 边界声明：能力目录为只读的静态注册表。管理控制台不提供任意 API 测试、路径构造或写操作执行功能；所有数据提取必须由 Agent 走 MCP 协议进行。
      </InlineAlert>

      {error ? <InlineAlert type="danger">{error}</InlineAlert> : null}

      <FilterCard>
        <FilterGroup>
          <FilterLabel>领域 (Domain)：</FilterLabel>
          <Select value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)}>
            <option value="all">全部领域</option>
            <option value="orders">Orders (订单)</option>
            <option value="inventory">Inventory (库存)</option>
            <option value="finances">Finances (财务)</option>
            <option value="products">Products & Pricing (商品与价格)</option>
            <option value="reports">Reports (报告数据)</option>
          </Select>
        </FilterGroup>

        <FilterGroup>
          <FilterLabel>可用性 (Availability)：</FilterLabel>
          <Select value={availabilityFilter} onChange={(e) => setAvailabilityFilter(e.target.value)}>
            <option value="all">全部状态</option>
            <option value="available">可用 (Available)</option>
            <option value="permission_required">需额外 Role 授权 (Permission Required)</option>
          </Select>
        </FilterGroup>
      </FilterCard>

      {loading ? (
        <EmptyWrap>正在读取服务能力注册表...</EmptyWrap>
      ) : capabilities.length === 0 ? (
        <EmptyWrap>暂无匹配的 SP-API 能力。</EmptyWrap>
      ) : (
        <Grid>
          {capabilities.map((item) => (
            <CapCard key={`${item.tool_name}:${item.action}`}>
              <CapHeader>
                <CapTitleGroup>
                  <CapTitle>{item.title || item.tool_name}</CapTitle>
                  <CapToolName>{item.tool_name}</CapToolName>
                </CapTitleGroup>
                <StatusBadge tone={item.availability === 'available' ? 'success' : 'warning'}>
                  {item.availability === 'available' ? '可用' : '需 Role 授权'}
                </StatusBadge>
              </CapHeader>

              <CapDesc>{item.description || '暂无说明'}</CapDesc>

              <MetaTable>
                <MetaRow>
                  <MetaKey>Domain / Action</MetaKey>
                  <MetaVal>{item.domain} · {item.action}</MetaVal>
                </MetaRow>
                <MetaRow>
                  <MetaKey>Amazon Role</MetaKey>
                  <MetaVal>{item.amazon_role || '—'}</MetaVal>
                </MetaRow>
                <MetaRow>
                  <MetaKey>只读安全属性</MetaKey>
                  <MetaVal>{item.is_readonly ? '只读 (Read-Only)' : '只读'}</MetaVal>
                </MetaRow>
                <MetaRow>
                  <MetaKey>支持区域</MetaKey>
                  <MetaVal>{item.supported_regions?.join(', ') || '—'}</MetaVal>
                </MetaRow>
              </MetaTable>
            </CapCard>
          ))}
        </Grid>
      )}
    </Container>
  )
}

const Container = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xl};
`

const Header = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.lg};
`

const HeaderLeft = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
`

const Title = styled.h1`
  margin: 0;
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.typeScale.title};
`

const Subtitle = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const FilterCard = styled(Card)`
  padding: ${({ theme }) => theme.space.lg};
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xl};
  flex-wrap: wrap;
`

const FilterGroup = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
`

const FilterLabel = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
  font-weight: 650;
`

const Select = styled.select`
  min-height: 38px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: 0 ${({ theme }) => theme.space.md};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const Grid = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.lg};
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
`

const CapCard = styled(Card)`
  padding: ${({ theme }) => theme.space.xl};
  display: grid;
  gap: ${({ theme }) => theme.space.md};
`

const CapHeader = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.md};
`

const CapTitleGroup = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
`

const CapTitle = styled.strong`
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.typeScale.lead};
`

const CapToolName = styled.code`
  color: ${({ theme }) => theme.colors.primaryStrong};
  font-size: ${({ theme }) => theme.typeScale.caption};
`

const CapDesc = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
  line-height: 1.5;
`

const MetaTable = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space.xs};
  border-top: 1px dashed ${({ theme }) => theme.colors.border};
  padding-top: ${({ theme }) => theme.space.md};
`

const MetaRow = styled.div`
  display: flex;
  justify-content: space-between;
  font-size: ${({ theme }) => theme.typeScale.small};
`

const MetaKey = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
`

const MetaVal = styled.span`
  color: ${({ theme }) => theme.colors.text};
  font-weight: 600;
  font-family: ${({ theme }) => theme.fonts.numeric};
`

const EmptyWrap = styled.div`
  padding: ${({ theme }) => theme.space.xl};
  text-align: center;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
`
