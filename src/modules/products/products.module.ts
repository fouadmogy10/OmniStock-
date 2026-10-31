import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Category } from './entities/category.entity';
import { Product } from './entities/product.entity';
import { CategoryService } from './category.service';
import { ProductService } from './product.service';
import { CategoryController } from './category.controller';
import { ProductController } from './product.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [TypeOrmModule.forFeature([Category, Product]), AuditModule],
  providers: [CategoryService, ProductService],
  controllers: [CategoryController, ProductController],
  exports: [CategoryService, ProductService],
})
export class ProductsModule {}

