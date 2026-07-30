import styled from '@emotion/styled'
import { Button } from './Button'

export function Pagination({
  currentPage,
  totalPages,
  onPageChange
}: {
  currentPage: number
  totalPages: number
  onPageChange: (page: number) => void
}) {
  if (totalPages <= 1) return null

  return (
    <Container>
      <Button
        variant="secondary"
        disabled={currentPage <= 1}
        onClick={() => onPageChange(currentPage - 1)}
        type="button"
        style={{ minHeight: 36, padding: '0 12px' }}
      >
        上一页
      </Button>
      <PageInfo>
        第 {currentPage} 页 / 共 {totalPages} 页
      </PageInfo>
      <Button
        variant="secondary"
        disabled={currentPage >= totalPages}
        onClick={() => onPageChange(currentPage + 1)}
        type="button"
        style={{ minHeight: 36, padding: '0 12px' }}
      >
        下一页
      </Button>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: ${({ theme }) => theme.space.md};
  margin-top: ${({ theme }) => theme.space.lg};
`

const PageInfo = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
  font-family: ${({ theme }) => theme.fonts.numeric};
`
