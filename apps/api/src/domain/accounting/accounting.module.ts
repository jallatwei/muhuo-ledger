import { Module } from '@nestjs/common';
import { VoucherService } from './voucher.service';
import { VoucherNumberService } from './voucher-number.service';
import { VoucherController } from './voucher.controller';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';

/**
 * 会计内核模块
 *
 * 注意：PrismaModule 虽然标了 @Global()，但它的导出（PrismaService /
 * AccountService / AuditService）仍需在消费模块里显式 import 才能注入 ——
 * @Global() 只是省去重复 import，不会自动把 provider 放进当前模块的注入作用域。
 */
@Module({
  imports: [PrismaModule],
  controllers: [VoucherController],
  providers: [VoucherService, VoucherNumberService],
  exports: [VoucherService, VoucherNumberService],
})
export class AccountingModule {}
