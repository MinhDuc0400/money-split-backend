import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
} from '@nestjs/common';
import { GroupsService } from './groups.service';
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { JoinGroupDto } from './dto/join-group.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Group, GroupMember } from '@prisma/client';
import type { Request } from 'express';
import '../common/interfaces/request-user.interface';

@ApiTags('groups')
@ApiBearerAuth()
@Controller('groups')
@UseGuards(JwtAuthGuard)
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new group' })
  @ApiResponse({
    status: 201,
    description: 'The group has been successfully created.',
  })
  create(
    @Req() req: Request,
    @Body() createGroupDto: CreateGroupDto,
  ): Promise<Group> {
    const userId = req.user!.id;
    return this.groupsService.create(userId, createGroupDto);
  }

  @Post('join')
  @ApiOperation({ summary: 'Join a group by invite code' })
  @ApiResponse({ status: 201, description: 'Successfully joined the group.' })
  @ApiResponse({ status: 404, description: 'Group not found.' })
  @ApiResponse({ status: 409, description: 'Already a member.' })
  join(
    @Req() req: Request,
    @Body() joinGroupDto: JoinGroupDto,
  ): Promise<GroupMember> {
    const userId = req.user!.id;
    return this.groupsService.join(userId, joinGroupDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all groups for the authenticated user' })
  @ApiResponse({ status: 200, description: 'Return all groups.' })
  findAll(@Req() req: Request): Promise<Group[]> {
    const userId = req.user!.id;
    return this.groupsService.findAll(userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a group by id' })
  @ApiResponse({ status: 200, description: 'Return the group.' })
  @ApiResponse({ status: 404, description: 'Group not found.' })
  findOne(@Req() req: Request, @Param('id') id: string): Promise<Group> {
    const userId = req.user!.id;
    return this.groupsService.findOne(id, userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a group' })
  @ApiResponse({
    status: 200,
    description: 'The group has been successfully updated.',
  })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() updateGroupDto: UpdateGroupDto,
  ): Promise<Group> {
    const userId = req.user!.id;
    return this.groupsService.update(id, userId, updateGroupDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a group' })
  @ApiResponse({
    status: 200,
    description: 'The group has been successfully deleted.',
  })
  @ApiResponse({
    status: 403,
    description: 'Only the owner can delete the group.',
  })
  remove(@Req() req: Request, @Param('id') id: string): Promise<Group> {
    const userId = req.user!.id;
    return this.groupsService.remove(id, userId);
  }
}
