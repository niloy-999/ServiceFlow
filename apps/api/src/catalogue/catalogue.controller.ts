import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { AuthenticatedRequest } from "../identity/session-auth.guard.js";
import { SessionAuthGuard } from "../identity/session-auth.guard.js";
import { CsrfService } from "../identity/csrf.service.js";
import { assertFrontendOrigin } from "../identity/request-origin.js";
import { readSessionCookie } from "../identity/session-cookie.js";
import {
  AddProductVariantDto,
  CatalogueTenantDto,
  CreateBrandDto,
  CreateCategoryDto,
  CreateProductDto,
  UpdateBrandDto,
  UpdateCategoryDto,
  UpdateProductDto,
  UpdateVariantDto,
} from "./dto/catalogue.dto.js";
import { CatalogueService } from "./catalogue.service.js";

interface CatalogueRequest extends AuthenticatedRequest {
  headers: AuthenticatedRequest["headers"] & {
    origin?: string;
    "x-csrf-token"?: string | string[];
  };
}

interface ResponseHeaders {
  setHeader(name: string, value: string): void;
}

@Controller("catalogue")
@UseGuards(SessionAuthGuard)
export class CatalogueController {
  constructor(
    private readonly catalogue: CatalogueService,
    private readonly csrf: CsrfService,
  ) {}

  private userId(request: CatalogueRequest): string {
    if (!request.authSession) throw new UnauthorizedException("Authentication is required.");
    return request.authSession.userId;
  }

  private verifyMutation(request: CatalogueRequest): string {
    assertFrontendOrigin(request.headers.origin);
    const sessionToken = readSessionCookie(request.headers.cookie);
    const suppliedToken = request.headers["x-csrf-token"];
    if (
      !sessionToken ||
      typeof suppliedToken !== "string" ||
      !this.csrf.verifyToken(sessionToken, suppliedToken)
    ) {
      throw new ForbiddenException("A valid CSRF token is required.");
    }
    return this.userId(request);
  }

  @Get(":tenantId/categories")
  async listCategories(
    @Param("tenantId") tenantId: string,
    @Req() request: CatalogueRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    response.setHeader("Cache-Control", "no-store");
    return { categories: await this.catalogue.listCategories(this.userId(request), tenantId) };
  }

  @Post("categories")
  createCategory(@Body() input: CreateCategoryDto, @Req() request: CatalogueRequest) {
    return this.catalogue.createCategory(this.verifyMutation(request), input);
  }

  @Post("categories/:categoryId/update")
  updateCategory(
    @Param("categoryId") categoryId: string,
    @Body() input: UpdateCategoryDto,
    @Req() request: CatalogueRequest,
  ) {
    return this.catalogue.updateCategory(this.verifyMutation(request), categoryId, input);
  }

  @Post("categories/:categoryId/archive")
  archiveCategory(
    @Param("categoryId") categoryId: string,
    @Body() input: CatalogueTenantDto,
    @Req() request: CatalogueRequest,
  ) {
    this.verifyMutation(request);
    return this.catalogue.archiveCategory(request.authSession!.userId, categoryId, input.tenantId);
  }

  @Get(":tenantId/brands")
  async listBrands(
    @Param("tenantId") tenantId: string,
    @Req() request: CatalogueRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    response.setHeader("Cache-Control", "no-store");
    return { brands: await this.catalogue.listBrands(this.userId(request), tenantId) };
  }

  @Post("brands")
  createBrand(@Body() input: CreateBrandDto, @Req() request: CatalogueRequest) {
    return this.catalogue.createBrand(this.verifyMutation(request), input);
  }

  @Post("brands/:brandId/update")
  updateBrand(
    @Param("brandId") brandId: string,
    @Body() input: UpdateBrandDto,
    @Req() request: CatalogueRequest,
  ) {
    return this.catalogue.updateBrand(this.verifyMutation(request), brandId, input);
  }

  @Post("brands/:brandId/archive")
  archiveBrand(
    @Param("brandId") brandId: string,
    @Body() input: CatalogueTenantDto,
    @Req() request: CatalogueRequest,
  ) {
    this.verifyMutation(request);
    return this.catalogue.archiveBrand(request.authSession!.userId, brandId, input.tenantId);
  }

  @Get(":tenantId/products")
  async listProducts(
    @Param("tenantId") tenantId: string,
    @Req() request: CatalogueRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    response.setHeader("Cache-Control", "no-store");
    return { products: await this.catalogue.listProducts(this.userId(request), tenantId) };
  }

  @Get(":tenantId/products/:productId")
  async getProduct(
    @Param("tenantId") tenantId: string,
    @Param("productId") productId: string,
    @Req() request: CatalogueRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    response.setHeader("Cache-Control", "no-store");
    return this.catalogue.getProduct(this.userId(request), tenantId, productId);
  }

  @Post("products")
  createProduct(@Body() input: CreateProductDto, @Req() request: CatalogueRequest) {
    return this.catalogue.createProduct(this.verifyMutation(request), input);
  }

  @Post("products/:productId/update")
  updateProduct(
    @Param("productId") productId: string,
    @Body() input: UpdateProductDto,
    @Req() request: CatalogueRequest,
  ) {
    return this.catalogue.updateProduct(this.verifyMutation(request), productId, input);
  }

  @Post("products/:productId/archive")
  archiveProduct(
    @Param("productId") productId: string,
    @Body() input: CatalogueTenantDto,
    @Req() request: CatalogueRequest,
  ) {
    this.verifyMutation(request);
    return this.catalogue.archiveProduct(request.authSession!.userId, productId, input.tenantId);
  }

  @Post("products/:productId/variants")
  addVariant(
    @Param("productId") productId: string,
    @Body() input: AddProductVariantDto,
    @Req() request: CatalogueRequest,
  ) {
    return this.catalogue.addVariant(this.verifyMutation(request), productId, input);
  }

  @Post("variants/:variantId/update")
  updateVariant(
    @Param("variantId") variantId: string,
    @Body() input: UpdateVariantDto,
    @Req() request: CatalogueRequest,
  ) {
    return this.catalogue.updateVariant(this.verifyMutation(request), variantId, input);
  }

  @Post("variants/:variantId/default")
  makeVariantDefault(
    @Param("variantId") variantId: string,
    @Body() input: CatalogueTenantDto,
    @Req() request: CatalogueRequest,
  ) {
    this.verifyMutation(request);
    return this.catalogue.makeVariantDefault(
      request.authSession!.userId,
      variantId,
      input.tenantId,
    );
  }

  @Post("variants/:variantId/archive")
  archiveVariant(
    @Param("variantId") variantId: string,
    @Body() input: CatalogueTenantDto,
    @Req() request: CatalogueRequest,
  ) {
    this.verifyMutation(request);
    return this.catalogue.archiveVariant(request.authSession!.userId, variantId, input.tenantId);
  }
}
